// WHICH NETWORKS MAY SETTLE AN ORDER — the one owner.
//
// Every package in this bot is priced by CURRENCY, not by chain
// (`price: { BNB: 1.5, SOL: 5, ETH: 0.26, … }` in config/packages.js), and the
// pay chain used to be locked to whatever chain the buyer's TOKEN lives on:
// `chain: payChainOf(f.chain)`. So a Solana project could only ever pay in SOL,
// and ETH — which every table already prices — was unreachable unless the token
// happened to live on an ETH chain.
//
// ⚠️ THE TWO ETH NETWORKS COST EXACTLY THE SAME, and that is not a coincidence
// worth restating anywhere else: `payNativeOf("ethereum") === "ETH" ===
// payNativeOf("robinhood")`, so both read the same row of the same table. This
// module adds a CHOICE OF NETWORK, never a second price.
//
// The rule for what may be offered:
//   • the order's own default chain, FIRST and unchanged — an existing buyer's
//     flow must not move under them, and a purchase in SOL is still a purchase;
//   • ETH on Ethereum and ETH on Robinhood Chain, when the package HAS an ETH
//     price. Trending is the reason that clause exists rather than being
//     assumed: its durations differ per currency (ETH has no 3H row, BNB has no
//     16H), so a network offered for a duration it cannot price would arm an
//     order for `undefined`.
//
// ⚠️ NOTHING HERE MAY BE TAKEN FROM CALLBACK DATA. The picker's callback
// carries a chain id the USER can craft, so `optionFor()` re-derives the whole
// list server-side and the amount comes from the price table — never from the
// tap. A chain that is not in the list is refused rather than armed.
const { payChainOf, payNativeOf, chainOf } = require("./chains");

// Both bill in ETH; Ethereum first because it is the one a buyer recognises.
// Robinhood is Dexvra's own chain and settles in seconds for a fraction of the
// fee, which is why it is worth offering beside mainnet rather than instead.
const ETH_NETWORKS = ["ethereum", "robinhood"];

// ⚠️ "Robinhood" ALONE IS AMBIGUOUS on the one line a buyer acts on: it is also
// a broker most of them have an account with, and the mistake this label exists
// to prevent is sending mainnet ETH from an exchange. The chain's own label is
// right everywhere else in the bot and wrong here.
const NETWORK_LABEL = { robinhood: "Robinhood Chain" };
const networkLabel = (id) => NETWORK_LABEL[id] || chainOf(id).label;

/** The networks this order may be settled on, default first.
 *
 *  @param order {{ chain, prices }} — `chain` is the order's own pay chain
 *         (already through payChainOf), `prices` is the package's own
 *         currency-keyed table, e.g. TIER_MAP[tier].price.
 *  @returns [{ chain, native, amount, label }]
 */
function payOptionsFor(order) {
  const prices = (order && order.prices) || {};
  const out = [];
  const seen = new Set();

  // ⚠️ NO payVia CHECK HERE, AND THAT IS DELIBERATE. A chain billed on another
  // chain (Sui → BSC) has no wallet adapter, so arming one would generate a key
  // nothing can sweep — but `payChainOf()` below has already resolved it, and
  // the two ETH networks are payable by definition, so no caller can reach this
  // with an unresolved id. A mutation run proved the guard dead: it is a
  // comment rather than a line claiming cover it does not provide. What keeps
  // it true is the payChainOf() call, and the Sui case pins it.
  const add = (chainId) => {
    if (!chainId || seen.has(chainId)) return;
    const native = payNativeOf(chainId);
    const amount = prices[native];
    if (!(Number(amount) > 0)) return;
    seen.add(chainId);
    out.push({ chain: chainId, native, amount, label: networkLabel(chainId) });
  };

  add(payChainOf(order && order.chain));
  for (const id of ETH_NETWORKS) add(id);
  return out;
}

/** The chosen option, re-derived and verified. Null if this order may not be
 *  settled on that chain — which is the answer to a crafted callback. */
function optionFor(order, chainId) {
  return payOptionsFor(order).find((o) => o.chain === chainId) || null;
}

module.exports = { payOptionsFor, optionFor, networkLabel, ETH_NETWORKS };
