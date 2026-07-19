// Chain registry — the bot's chain ids MUST match dexvra's src/config/chains.ts
// (the web store validates `chain` against them). Adding a chain is one entry.
// `family` selects the payment adapter; `native`/`decimals` drive on-chain
// amount math; `geckoNetwork` drives live market data for posts.

const CHAINS = {
  solana: {
    id: "solana", label: "Solana", native: "SOL", family: "solana", decimals: 9,
    geckoNetwork: "solana",
    addressPattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    explorer: (a) => `https://solscan.io/token/${a}`,
    buyUrl: (a) => `https://jup.ag/swap/SOL-${a}`,
  },
  bsc: {
    id: "bsc", label: "BSC", native: "BNB", family: "evm", decimals: 18,
    geckoNetwork: "bsc",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://bscscan.com/token/${a}`,
    buyUrl: (a) => `https://pancakeswap.finance/swap?outputCurrency=${a}`,
  },
  ethereum: {
    id: "ethereum", label: "Ethereum", native: "ETH", family: "evm", decimals: 18,
    geckoNetwork: "eth",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://etherscan.io/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=mainnet&outputCurrency=${a}`,
  },
  base: {
    id: "base", label: "Base", native: "ETH", family: "evm", decimals: 18,
    geckoNetwork: "base",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://basescan.org/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=base&outputCurrency=${a}`,
  },
  robinhood: {
    id: "robinhood", label: "Robinhood", native: "ETH", family: "evm", decimals: 18,
    geckoNetwork: null, // no GeckoTerminal coverage yet
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://dexscreener.com/search?q=${a}`,
    buyUrl: (a) => `https://dexscreener.com/search?q=${a}`,
  },
  tron: {
    id: "tron", label: "Tron", native: "TRX", family: "tron", decimals: 6,
    geckoNetwork: "tron",
    addressPattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    explorer: (a) => `https://tronscan.org/#/token20/${a}`,
    buyUrl: (a) => `https://sunswap.com/#/home?tokenAddress=${a}`,
  },
  ton: {
    id: "ton", label: "TON", native: "TON", family: "ton", decimals: 9,
    geckoNetwork: "ton",
    addressPattern: /^(EQ|UQ|0:)[A-Za-z0-9_-]{40,66}$/,
    explorer: (a) => `https://tonviewer.com/${a}`,
    buyUrl: (a) => `https://app.ston.fi/swap?ft=TON&tt=${a}`,
  },
  // ── payVia chains — listed/tracked here, but PAID on another chain (the
  //    fourtis "monad via ETH/Base" pattern). No wallet adapter needed: every
  //    payment call routes through payChainOf() below. ──
  sui: {
    id: "sui", label: "Sui", native: "SUI", family: null, payVia: "bsc", decimals: 9,
    geckoNetwork: "sui-network",
    // Sui coin type: 0x<hex>::module::SYMBOL (bare object addresses accepted too)
    addressPattern: /^0x[a-fA-F0-9]{1,64}(::[A-Za-z0-9_]+){0,2}$/,
    explorer: (a) => `https://suivision.xyz/coin/${encodeURIComponent(a)}`,
    buyUrl: (a) => `https://app.cetus.zone/swap/?to=${encodeURIComponent(a)}`,
  },
  plasma: {
    id: "plasma", label: "Plasma", native: "XPL", family: null, payVia: "ethereum", decimals: 18,
    geckoNetwork: "plasma",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://dexscreener.com/plasma/${a}`,
    buyUrl: (a) => `https://dexscreener.com/plasma/${a}`,
  },
};

// Menu / selector order across the bot (mirrors the website's chain order).
const CHAIN_ORDER = ["solana", "bsc", "ethereum", "base", "robinhood", "tron", "ton", "sui", "plasma"];
const CHAIN_IDS = CHAIN_ORDER.filter((id) => CHAINS[id]);

const chainOf = (id) => CHAINS[id] || null;
const nativeOf = (id) => CHAINS[id]?.native || "SOL";
const decimalsOf = (id) => CHAINS[id]?.decimals ?? 9;
const familyOf = (id) => CHAINS[id]?.family || null;

/** The chain PAYMENT actually happens on (Sui pays in BNB on BSC, Plasma pays
 *  in ETH on Ethereum). Identity for chains with their own wallet adapter. */
const payChainOf = (id) => CHAINS[id]?.payVia || id;
/** Native coin the buyer sends for a listing on `id` (SUI → BNB, XPL → ETH). */
const payNativeOf = (id) => nativeOf(payChainOf(id));
/** Chains money can be RECEIVED on (banner pay-method picker etc). */
const PAYABLE_CHAIN_IDS = CHAIN_IDS.filter((id) => !CHAINS[id].payVia);

/** Loose per-chain contract-address validation (the fourtis bot skipped this — we don't). */
function isValidAddress(chain, address) {
  const c = CHAINS[chain];
  if (!c || typeof address !== "string") return false;
  return c.addressPattern.test(address.trim());
}

module.exports = {
  CHAINS,
  CHAIN_ORDER,
  CHAIN_IDS,
  PAYABLE_CHAIN_IDS,
  chainOf,
  nativeOf,
  decimalsOf,
  familyOf,
  payChainOf,
  payNativeOf,
  isValidAddress,
};
