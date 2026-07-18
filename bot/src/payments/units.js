// Smallest-unit conversion per chain. Everything on the payment path is a BigInt
// in the chain's smallest unit (wei / lamports / sun / nanoton) and compared
// with >=. ethers.parseUnits handles any decimal count exactly.
const { ethers } = require("ethers");
const { decimalsOf, nativeOf } = require("../config/chains");

/** human amount (e.g. 0.06, "5") → BigInt smallest unit for the chain.
 *  Uses the value's shortest round-trip string (so 0.06 stays 0.06, not
 *  0.059999…) and truncates excess fraction digits by string slicing — never
 *  Number.toFixed, which reintroduces binary float error. */
function toSmallest(chain, human) {
  const d = decimalsOf(chain);
  let s = typeof human === "string" ? human.trim() : String(human);
  if (/[eE]/.test(s)) s = Number(s).toFixed(d); // expand rare scientific notation
  const [int, frac = ""] = s.split(".");
  const fracTrim = frac.slice(0, d);
  s = fracTrim ? `${int}.${fracTrim}` : int || "0";
  return ethers.parseUnits(s, d);
}

/** BigInt smallest unit → human string (trailing zeros trimmed). */
function toHuman(chain, amount) {
  const d = decimalsOf(chain);
  const s = ethers.formatUnits(BigInt(amount), d);
  return s.replace(/\.?0+$/, "") || "0";
}

/** e.g. "0.06 ETH" for display. */
function humanWithSymbol(chain, amount) {
  return `${toHuman(chain, amount)} ${nativeOf(chain)}`;
}

module.exports = { toSmallest, toHuman, humanWithSymbol };
