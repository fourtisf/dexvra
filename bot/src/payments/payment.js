// Payment arming + the Confirm-payment handler.
//
// armPayment(): generate a fresh temp wallet, quote the amount, persist a
// restart-recoverable order (with a serializable fulfilment payload), and stash
// it on the session. The calling flow renders the pay card.
//
// confirmPayHandler(): idempotent Confirm button. Verifies the on-chain balance
// (sweep fires inside verify, BEFORE fulfilment), then runs fulfilment. Because
// funds are already captured, fulfilment must be best-effort and never "refund"
// on failure — a failed fulfil leaves the order in `paid` for recovery.
const crypto = require("node:crypto");
const { isAdminUser } = require("../config/constants");
const { answer, toast } = require("../helpers/message");
const { escapeHtml } = require("../helpers/format");
const { toSmallest, humanWithSymbol } = require("./units");
const wallets = require("./wallets");
const verify = require("./verify");
const orders = require("./orders");
const tpl = require("../templates");
const premium = require("../premium");
const log = require("../helpers/logger");

const SERVICE_LABEL = {
  xpress_listing: "Xpress Listing",
  tiered_listing: "Listing & Trending",
  trending: "Trending",
  banner: "Banner Ad",
};
const serviceLabel = (k) => SERVICE_LABEL[k] || k;

function newOrderId() {
  return `${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * @param order {{ kind, chain, native, humanAmount, payload, label? }}
 * @returns {{ address, amount, adminFree, native, humanAmount }}
 */
async function armPayment(ctx, order) {
  const adminFree = isAdminUser(ctx);
  order.id = order.id || newOrderId();
  order.buyerId = ctx.from && ctx.from.id;
  order.buyerUsername = ctx.from && ctx.from.username;
  order.createdAt = Date.now();
  order.status = "pending";

  const wallet = await wallets.generateWallet(order.chain, {
    orderId: order.id,
    service: serviceLabel(order.kind),
    plan: order.label,
    buyerId: order.buyerId,
    buyerUsername: order.buyerUsername,
    amountHuman: adminFree ? "FREE (admin)" : `${order.humanAmount} ${order.native}`,
  });
  const amount = adminFree ? 0n : toSmallest(order.chain, order.humanAmount);
  order.amountSmallest = amount.toString();
  order.address = wallet.address;
  order.adminFree = adminFree;
  await orders.saveOrder(order).catch((e) => log.warn(`[pay] saveOrder: ${e.message}`));

  ctx.session.pendingPayment = { order, address: wallet.address, adminFree };
  return { address: wallet.address, amount, adminFree, native: order.native, humanAmount: order.humanAmount };
}

async function confirmPayHandler(ctx) {
  await answer(ctx);
  const pp = ctx.session && ctx.session.pendingPayment;
  if (!pp) {
    await toast(ctx, tpl.render("no_pending_payment"));
    return;
  }
  if (ctx.session._verifying) {
    await toast(ctx, tpl.render("still_checking"));
    return;
  }
  ctx.session._verifying = true;
  const { order, address, adminFree } = pp;

  // Immediate on-tap feedback — the buyer must SEE the check is running the
  // moment they tap Confirm (not just a silent spinner). Shown for every tap.
  await toast(
    ctx,
    adminFree
      ? "⏳ Running your order — hang tight…"
      : tpl.render("checking_payment", { chain: order.chain.toUpperCase(), amount: order.humanAmount, native: order.native }),
  );

  try {
    let paid = adminFree;
    if (!adminFree) {
      const r = await verify.verifyPayment(order.chain, address, order.amountSmallest);
      paid = r.paid;
    }

    if (!paid) {
      // The buyer is most likely about to re-send: keep the address copyable
      // here too, same as on the pay card.
      const menu = require("../handlers/menu");
      await toast(
        ctx,
        premium.ensureCode(
          tpl.render("payment_not_detected", {
            amount: order.humanAmount,
            native: order.native,
            address,
            order: order.id,
          }),
          address,
        ),
        menu.copyAddress(address),
      );
      return;
    }

    await orders.setStatus(order.id, "paid").catch(() => {});
    // The payment is confirmed, so the pending card is spent. Cleared HERE,
    // while the middleware chain still owns the session: Telegraf writes
    // ctx.session back after next() resolves, so the same assignment made from
    // the detached runner below would be dropped on the floor.
    ctx.session.pendingPayment = null;
    // ⚠️ FULFILMENT IS DELIBERATELY NOT AWAITED.
    //
    // Telegraf is built with handlerTimeout: 120000, and a tiered listing does
    // not fit in two minutes: an animated custom-emoji build (48 canvas frames
    // + an ffmpeg bitrate ladder), a market read, TWO ffmpeg composites of the
    // admin clip (listing + trending), the X tweet raced to X_POST_TIMEOUT_MS,
    // and three or four video uploads to Telegram — every one of them serial.
    // Hit for real on 2026-09-06: the buyer tapped Confirm at 14:24, saw
    // "Running your order — hang tight…", and at 14:26 the ops channel got
    // "[telegraf] callback_query handler error: Promise timed out after 120000
    // milliseconds". The timeout does NOT cancel the work — the listing still
    // went live — so the only thing it changed was that the buyer got an error
    // instead of the receipt they paid for.
    //
    // This is the atrun lesson on the money path: a callback answer is the one
    // channel with a DEADLINE, so it carries the ACKNOWLEDGEMENT and the RESULT
    // arrives as a message, which has none. The buyer already has the
    // "Running your order" toast above; fulfilment posts its own receipt.
    // .catch is belt-and-braces: runFulfilment already swallows everything,
    // and an unhandled rejection with nobody awaiting it ends the process.
    runFulfilment(ctx, order, adminFree).catch(() => {});
    return;
  } catch (e) {
    log.error(`[pay] confirm failed order=${order && order.id}: ${e.message}`);
    await toast(ctx, tpl.render("payment_snag", { order: order && order.id }));
  } finally {
    ctx.session._verifying = false;
  }
}

// Orders being fulfilled right now. The session flag cannot do this job: it is
// cleared when the handler returns, which is now BEFORE fulfilment finishes, so
// a second tap would start a second run of a paid order. Same guard, same
// reason, as atRunBusy on the slow ⚡ Run now button.
const fulfilling = new Set();

/**
 * Run a paid order to completion, off the callback deadline.
 *
 * Never throws: it is already the detached tail of a handler that has returned,
 * so an exception here has nowhere to go but the process.
 */
async function runFulfilment(ctx, order, adminFree) {
  if (fulfilling.has(order.id)) {
    log.warn(`[pay] order ${order.id} is already being fulfilled — ignoring the repeat`);
    return;
  }
  fulfilling.add(order.id);
  const t0 = Date.now();
  try {
    const { fulfillOrder } = require("../fulfillment");
    await fulfillOrder(ctx, order);
    await orders.setStatus(order.id, "fulfilled").catch(() => {});
    const u = ctx.from || {};
    const usernameTag = u.username
      ? `@${u.username}`
      : order.buyerUsername
        ? `@${order.buyerUsername}`
        : "(none)";
    const fullName = `${u.first_name || ""} ${u.last_name || ""}`.trim();
    const amountLine = adminFree
      ? "FREE (admin)"
      : `${order.humanAmount} ${order.native} <i>(${order.amountSmallest} units)</i>`;
    log.report(
      `💸 <b>Service Purchased</b>\n` +
        `<b>User ID:</b> <code>${order.buyerId}</code>\n` +
        `<b>Username:</b> ${escapeHtml(usernameTag)}\n` +
        `<b>Full Name:</b> ${escapeHtml(fullName || "(none)")}\n` +
        `<b>Service:</b> ${escapeHtml(serviceLabel(order.kind))}\n` +
        `<b>Plan:</b> ${escapeHtml(order.label || "-")}\n` +
        `<b>Chain:</b> ${String(order.chain).toUpperCase()}\n` +
        `<b>Amount:</b> ${amountLine}\n` +
        `<b>Order:</b> <code>${order.id}</code>\n` +
        `<b>Date:</b> ${new Date().toISOString()}`,
    );
    log.info(`[fulfil] order ${order.id} (${order.kind}) delivered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    // The buyer has PAID and is holding a "hang tight" toast, so silence here is
    // the worst outcome. Say so, name the order, and leave it 'paid' rather than
    // 'fulfilled' so recovery.js can pick it up.
    log.error(`[pay] fulfil FAILED order=${order && order.id} after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message}`);
    await toast(ctx, tpl.render("payment_snag", { order: order && order.id })).catch(() => {});
  } finally {
    fulfilling.delete(order.id);
  }
}

module.exports = { armPayment, confirmPayHandler, newOrderId, humanWithSymbol };
