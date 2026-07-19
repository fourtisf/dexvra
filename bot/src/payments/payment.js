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

  try {
    let paid = adminFree;
    if (!adminFree) {
      await toast(
        ctx,
        tpl.render("checking_payment", { chain: order.chain.toUpperCase(), amount: order.humanAmount, native: order.native }),
      );
      const r = await verify.verifyPayment(order.chain, address, order.amountSmallest);
      paid = r.paid;
    }

    if (!paid) {
      await toast(
        ctx,
        tpl.render("payment_not_detected", {
          amount: order.humanAmount,
          native: order.native,
          address,
          order: order.id,
        }),
      );
      return;
    }

    await orders.setStatus(order.id, "paid").catch(() => {});
    const { fulfillOrder } = require("../fulfillment");
    await fulfillOrder(ctx, order);
    await orders.setStatus(order.id, "fulfilled").catch(() => {});
    ctx.session.pendingPayment = null;
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
  } catch (e) {
    log.error(`[pay] confirm/fulfil failed order=${order && order.id}: ${e.message}`);
    await toast(ctx, tpl.render("payment_snag", { order: order && order.id }));
  } finally {
    ctx.session._verifying = false;
  }
}

module.exports = { armPayment, confirmPayHandler, newOrderId, humanWithSymbol };
