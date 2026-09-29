'use strict';
/**
 * IS THIS TOKEN FIT TO BE LISTED FOR FREE?
 *
 * "masa anda free listingkan token seperti ini … ini skem token" — with a
 * screenshot of the channel announcing **Shiba Inu ($SHIB) on Solana** to
 * 12,430 subscribers, drawn with the DEXVRA mark because the token had no
 * artwork, beside its DexScreener page:
 *
 *   MKT CAP $5.9M · LIQUIDITY $5.6M · 5M/1H/6H/24H 0% · 7 traders · 25 holders
 *
 * Every one of the free-listing gates passed, because every one of them asks
 * how BIG a token is (cap, liquidity, volume, age) and none of them asks
 * whether it is REAL. A token that exists to be mistaken for something else
 * clears a size floor by construction — the size is the bait. Four facts on
 * that one screen each say so on their own, and each is a check here:
 *
 *  1. IMPERSONATION. `SHIB` is Shiba Inu's ticker, and Shiba Inu lives on
 *     Ethereum at one address. A `SHIB` anywhere else is a copy — a bridge at
 *     best, a scam at worst — and neither is a new project to announce.
 *  2. NO ARTWORK. A real project publishes a logo; the banner then draws the
 *     Dexvra diamond where the token's own picture belongs, which reads as our
 *     own listing of nothing.
 *  3. LIQUIDITY ≈ MARKET CAP. In a pool, the depth DexScreener reports is both
 *     sides valued at the pool price, so a pool holding the whole supply reads
 *     liquidity ≈ market cap — nobody holds the token, the "cap" is the pool
 *     pricing itself. Traded tokens past $1M sit at a fraction of that.
 *  4. A PRICE THAT DID NOT MOVE. 0.00% over 1h, 6h and 24h while trades are
 *     reported is not a quiet market — no traded token is flat to the cent for
 *     a day. It is a pinned range or the same wallets trading with themselves.
 *
 * ⚠️ PURE, AND THE ONE OWNER. `autoLister.createFromInfo` calls it, which is the
 * door every free listing goes through (the scan, ⚡ Run now, the board filler,
 * the chain seeder), and `rejectReason` calls it so the scan COUNTS the refusal
 * under its own reason rather than finding out at the create. A check a second
 * door has to remember is one the third door forgets — which is exactly how the
 * discovery feeds ended up with no stablecoin filter.
 *
 * ⚠️ A MISSING READING NEVER TRIPS 3 OR 4. Those are claims about the market,
 * and a source that does not publish the field (GeckoTerminal candidates, a
 * launchpad record) has made no claim. Only 1 and 2 bind every door, because
 * a ticker, a name and a logo are on every record.
 *
 * Paid listings are untouched: this is the bar for what the BOT lists on its
 * own, never for what a customer may buy.
 */

// ── 1. The tickers that already belong to somebody ──────────────────────────
//
// `home` maps a chain to the ONE contract that is the real token there. A
// major with no entry for a chain has no genuine copy on that chain at all.
//
// ⚠️ An address is listed only where it is certain. A wrong one refuses the
// REAL token (a missed free listing — the fail-safe direction); a guessed one
// that happened to be a scam's would wave that scam through. Tokens whose home
// contract is not written down here (SUN, BTT, WIN on Tron…) are deliberately
// ABSENT rather than homeless, or the board filler — which lists the real ones
// — would stop being able to.
//
// Names are matched EXACTLY (after folding case and spacing), never as a
// prefix: "Baby Shiba Inu" is a memecoin with its own ticker and is not
// pretending to be anything.
const MAJORS = {
  BTC: { names: ['bitcoin'] },
  ETH: { names: ['ethereum', 'ether'] },
  SOL: { names: ['solana'] },
  BNB: { names: ['bnb', 'binance coin'] },
  XRP: { names: ['xrp', 'ripple'] },
  ADA: { names: ['cardano'] },
  DOGE: { names: ['dogecoin'] },
  TRX: { names: ['tron'] },
  TON: { names: ['toncoin', 'the open network'] },
  AVAX: { names: ['avalanche'] },
  DOT: { names: ['polkadot'] },
  LTC: { names: ['litecoin'] },
  BCH: { names: ['bitcoin cash'] },
  XLM: { names: ['stellar'] },
  NEAR: { names: ['near', 'near protocol'] },
  ATOM: { names: ['cosmos', 'cosmos hub'] },
  APT: { names: ['aptos'] },
  SUI: { names: ['sui'] },
  HBAR: { names: ['hedera'] },
  ICP: { names: ['internet computer'] },
  FIL: { names: ['filecoin'] },
  KAS: { names: ['kaspa'] },
  TAO: { names: ['bittensor'] },
  TIA: { names: ['celestia'] },
  INJ: { names: ['injective'] },
  XMR: { names: ['monero'] },
  ETC: { names: ['ethereum classic'] },
  HYPE: { names: ['hyperliquid'] },
  SHIB: { names: ['shiba inu'], home: { ethereum: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE' } },
  PEPE: { names: ['pepe'], home: { ethereum: '0x6982508145454Ce325dDbE47a25d4ec3d2311933' } },
  FLOKI: {
    names: ['floki', 'floki inu'],
    home: { ethereum: '0xcf0C122c6b73ff809C693DB761e7BaeBe62b6a2E', bsc: '0xfb5B838b6cfEEdC2873aB27866079AC55363D37E' },
  },
  LINK: { names: ['chainlink'], home: { ethereum: '0x514910771AF9Ca656af840dff83E8264EcF986CA' } },
  UNI: { names: ['uniswap'], home: { ethereum: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' } },
  AAVE: { names: ['aave'], home: { ethereum: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' } },
  LDO: { names: ['lido dao'], home: { ethereum: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32' } },
  MKR: { names: ['maker'], home: { ethereum: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2' } },
  CRV: { names: ['curve dao token'], home: { ethereum: '0xD533a949740bb3306d119CC777fa900bA034cd52' } },
  ONDO: { names: ['ondo', 'ondo finance'], home: { ethereum: '0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3' } },
  ENA: { names: ['ethena'], home: { ethereum: '0x57e114B691Db790C35207b2e685D4A43181e6061' } },
  MOG: { names: ['mog coin'], home: { ethereum: '0xaaeE1A9723aaDB7afA2810263653A34bA2C21C7a' } },
  SPX: { names: ['spx6900'], home: { ethereum: '0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C' } },
  POL: { names: ['polygon', 'polygon ecosystem token'], home: { ethereum: '0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6' } },
  MATIC: { names: ['matic network'] },
  ARB: { names: ['arbitrum'], home: { arbitrum: '0x912CE59144191C1204E64559FE8253a0e49E6548' } },
  OP: { names: ['optimism'], home: { optimism: '0x4200000000000000000000000000000000000042' } },
  CAKE: { names: ['pancakeswap', 'pancakeswap token'], home: { bsc: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82' } },
  BRETT: { names: ['brett'], home: { base: '0x532f27101965dd16442E59d40670FaF5eBB142E4' } },
  TOSHI: { names: ['toshi'], home: { base: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4' } },
  AERO: { names: ['aerodrome finance', 'aerodrome'], home: { base: '0x940181a94A35A4569E4529A3CDfB74e38FD98631' } },
  BONK: { names: ['bonk'], home: { solana: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' } },
  WIF: { names: ['dogwifhat'], home: { solana: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' } },
  TRUMP: { names: ['official trump'], home: { solana: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN' } },
  POPCAT: { names: ['popcat'], home: { solana: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' } },
  JUP: { names: ['jupiter'], home: { solana: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' } },
  PYTH: { names: ['pyth network'], home: { solana: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3' } },
  RAY: { names: ['raydium'], home: { solana: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' } },
};

// A ticker is judged on its letters: `$SHIB`, `shib` and ` SHIB ` are one ticker.
const foldSym = (s) => String(s == null ? '' : s).replace(/^\$+/, '').trim().toUpperCase();
const foldName = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const BY_NAME = new Map();
for (const [sym, m] of Object.entries(MAJORS)) for (const n of m.names || []) BY_NAME.set(foldName(n), sym);

// Base58 (Solana) and Tron addresses are CASE-SENSITIVE; only 0x hex folds.
const sameAddress = (a, b) => {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x || !y) return false;
  return /^0x/i.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/**
 * The major this token presents itself as and is not, or null.
 * `{ sym, name }` — the ticker it borrowed and the project that owns it.
 */
function impersonates(chain, address, symbol, name) {
  const bySym = foldSym(symbol);
  const major = MAJORS[bySym] ? bySym : BY_NAME.get(foldName(name)) || null;
  if (!major) return null;
  const home = (MAJORS[major].home || {})[String(chain || '').toLowerCase()];
  if (home && sameAddress(home, address)) return null; // the genuine article
  // Stored lowercase for matching; shown the way the project spells itself.
  const shown = MAJORS[major].names[0].replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
  return { sym: major, name: shown };
}

// ── 3. Liquidity ≈ market cap ───────────────────────────────────────────────
// Past this share of the cap, the pool is holding most of the supply. A real
// $1M+ memecoin sits at 5–30%; the reported token sat at 95%.
const LIQ_MCAP_MAX = 0.6;

// ── 4. A flat price under trading ───────────────────────────────────────────
// Every window must be PUBLISHED and exactly 0 — an absent reading is not a
// flat one — and there must be trades to make the flatness mean anything.
const FLAT_WINDOWS = ['h1', 'h6', 'h24'];

function isFlat(info) {
  const pc = info && info.priceChange;
  if (!pc || typeof pc !== 'object') return false;
  if (!(Number(info.vol24) > 0)) return false;
  return FLAT_WINDOWS.every((w) => typeof pc[w] === 'number' && pc[w] === 0);
}

const HTTP_LOGO = /^https?:\/\/\S+$/i;

/**
 * Why this token may not be listed for free, or null.
 *
 * The reason strings are prefixed consistently (`impersonates`, `no logo`,
 * `liquidity ≈`, `flat price`) because the scan's report tallies reasons by
 * their text and `coolUntil` decides from it how long to leave a token alone.
 */
function qualityRefusal(chain, address, info) {
  if (!info) return null;
  const fake = impersonates(chain, address, info.symbol, info.name);
  if (fake) {
    // Variable parts in parentheses: the scan tallies reasons with the
    // parenthesised figures stripped, so every impersonator is ONE bucket.
    return `impersonates a major coin ($${fake.sym} ${fake.name}, not its contract on ${chain})`;
  }
  if (!HTTP_LOGO.test(String(info.logoUrl || '').trim())) return 'no logo';
  const mcap = Number(info.mcap) || 0;
  const liq = Number(info.liq) || 0;
  if (mcap > 0 && liq > 0 && liq / mcap > LIQ_MCAP_MAX) {
    return `liquidity ≈ market cap (${Math.round((liq / mcap) * 100)}% — the pool holds the supply)`;
  }
  if (isFlat(info)) return 'flat price (0.00% over 1h, 6h and 24h despite trades)';
  return null;
}

module.exports = { qualityRefusal, impersonates, isFlat, MAJORS, LIQ_MCAP_MAX, _foldSym: foldSym };
