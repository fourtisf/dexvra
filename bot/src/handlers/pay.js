// Shared "choose a network → arm payment → render the pay card" step used by
// every flow. The pay card text is an editable template (pay_card /
// pay_card_admin); the picker is pay_pick.
const { Markup } = require("telegraf");
const { armPayment } = require("../payments/payment");
const { sendCard, answer, toast } = require("../helpers/message");
const { payOptionsFor, optionFor, networkLabel } = require("../config/payOptions");
const menu = require("./menu");
const premium = require("../premium");
const tpl = require("../templates");

/**
 * ⚠️ THE NETWORK LINE IS ENFORCED HERE, NOT TRUSTED TO THE TEMPLATE.
 *
 * Same reason the address and the amount are — "enforced here rather than
 * trusted to the template's backticks, which a re-saved card loses". An
 * operator who edited `pay_card` in @dexvraadminbot keeps THEIR copy for ever
 * (data/templates.json wins over the code default), so a card saved before this
 * shipped would render no network at all — and the two ETH options settle on
 * different chains behind the same `0x` address shape. That is the one line on
 * this card whose absence costs a buyer their money, so it is appended when the
 * rendered text does not already carry it.
 *
 * Appended at the END, which is what makes it safe: Telegram entity offsets are
 * UTF-16 code units counted from the start, so nothing already in the payload
 * moves. The `html` shape is handled separately because entities do not apply.
 *
 * ⚠️ THE "ALREADY THERE" TEST IS THE RENDERED PHRASE, NEVER A BARE MENTION.
 * `text.includes("Ethereum")` is satisfied by an operator card that happens to
 * say "we accept Ethereum, Solana and BNB" — a sentence that names no network
 * for THIS order and suppressed the enforced line completely. `Network: <name>`
 * is what the template emits, so it is the only thing that proves the line is
 * on the card.
 */
function ensureNetwork(payload, network) {
  if (!payload || typeof payload !== "object" || !network) return payload;
  const said = `Network: ${network}`;
  const line = `\n\n🔗 ${said} — send on this network only.`;
  if (payload.html != null) {
    const html = String(payload.html);
    if (html.includes(said)) return payload;
    return { ...payload, html: `${html}\n\n🔗 <b>${said}</b> — send on this network only.` };
  }
  const text = String(payload.text || "");
  if (text.includes(said)) return payload;
  // Bold the "Network: <name>" run so it reads as the instruction it is.
  const boldFrom = text.length + "\n\n🔗 ".length;
  const boldLen = said.length;
  return {
    ...payload,
    text: text + line,
    entities: [...(payload.entities || []), { type: "bold", offset: boldFrom, length: boldLen }],
  };
}

/** Render the network picker for an order that can settle on more than one. */
async function askNetwork(ctx, order, options) {
  // Stashed whole: the flow that built this order has moved on by the time the
  // tap lands, and rebuilding it from the form would be a second owner of what
  // the buyer is purchasing. It is plain data — the same shape armPayment
  // persists — so nothing here depends on a closure surviving.
  ctx.session.payPick = order;
  const rows = options.map((o) => [
    Markup.button.callback(`${o.amount} ${o.native} · ${o.label}`, `paynet_${o.chain}`),
  ]);
  await sendCard(
    ctx,
    tpl.render("pay_pick", { label: premium.sanitizeVar(order.label || order.kind) }),
    menu.withHome(rows),
  );
}

/**
 * @param order {{ kind, chain, native, humanAmount, label, payload,
 *                 prices?, payChain? }}
 *   `prices` is the package's own currency-keyed table (TIER_MAP[t].price and
 *   friends). Supplying it is what offers the buyer a choice of network; a
 *   caller that omits it — the banner flow, which has a USD picker of its own —
 *   behaves exactly as it did before this existed.
 *   `payChain` pins the choice and is set ONLY by netPick below.
 */
async function startPayment(ctx, order) {
  const options = payOptionsFor(order);
  if (options.length > 1 && !order.payChain) return askNetwork(ctx, order, options);

  // ⚠️ THE AMOUNT COMES FROM THE TABLE, NEVER FROM THE TAP. `payChain` arrives
  // as callback data the user can craft, so the option is re-derived here and a
  // chain this order may not settle on is refused rather than armed.
  const picked = order.payChain ? optionFor(order, order.payChain) : options[0];
  if (order.payChain && !picked) return toast(ctx, tpl.render("session_expired"));
  const priced = picked
    ? { ...order, chain: picked.chain, native: picked.native, humanAmount: picked.amount }
    : order;
  // ⚠️ NAMED FROM THE CHAIN BEING ARMED, never only from a picked option. With
  // no `prices` table there is nothing to pick, and `""` rendered the card's one
  // load-bearing line as "🔗 Network:  — send on this network only." — a blank
  // where the network goes, on the message that takes the money. Every caller
  // passes a table today (a test scans for it); the sixth flow added later is
  // the one this is for.
  const network = picked ? picked.label : networkLabel(priced.chain);

  const r = await armPayment(ctx, priced);
  // label embeds the user's symbol — sanitize so it can't inject markup
  const label = premium.sanitizeVar(priced.label || priced.kind);
  if (r.adminFree) {
    await sendCard(ctx, tpl.render("pay_card_admin", { label }), menu.confirmPayment());
    return;
  }
  // The address (and the exact amount) are tap-to-copy: enforced here rather
  // than trusted to the template's backticks, which a re-saved card loses.
  const text = premium.ensureCode(
    ensureNetwork(
      tpl.render("pay_card", { label, amount: r.humanAmount, native: r.native, address: r.address, network }),
      network,
    ),
    r.address,
    r.humanAmount,
  );
  await sendCard(ctx, text, menu.confirmPayment(r.address));
}

/** `paynet_<chain>` — the buyer picked a network. */
async function netPick(ctx) {
  await answer(ctx);
  const order = ctx.session && ctx.session.payPick;
  if (!order) return toast(ctx, tpl.render("session_expired"));
  const chain = ctx.match[1];
  // Checked HERE as well as on the arming path, and the difference is what the
  // buyer keeps: refusing before the stash is spent leaves their pending choice
  // intact, so a stale tap on an older picker card costs them nothing. The
  // arming guard below is what makes a crafted chain unspendable; this one is
  // what makes a stray one harmless.
  if (!optionFor(order, chain)) return toast(ctx, tpl.render("session_expired"));
  ctx.session.payPick = null; // spent — a second tap must not re-arm the order
  await startPayment(ctx, { ...order, payChain: chain });
}

module.exports = { startPayment, netPick, ensureNetwork };
