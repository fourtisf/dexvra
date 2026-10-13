'use strict';
/*
 * A Solana token's own metadata, read off the CHAIN — for the listing form.
 *
 * "bot tidak detect socials nya pdahal tokenya ada website dan x". BINWISE
 * ($BWS, a pump.fun mint) was pasted into the listing flow and the review card
 * came back `Website: not set · X: not set · Telegram: not set` over an
 * auto-written overview — about a token whose pump.fun page shows its X and
 * its website in the same minute.
 *
 * Nothing in the form was wrong; the wiring copies whatever the merge hands
 * it. Every source the merge had is a THIRD PARTY over HTTP, and each one has
 * a way to answer with no socials that is not a fact about the token:
 *
 *   · DexScreener carries socials only for a token whose project paid for a
 *     profile — an ordinary pump.fun launch has a pair and an empty `info`;
 *   · pump.fun's own API blocks datacenter ranges, which is what the box is,
 *     and its breaker benches it after three transport failures;
 *   · Jupiter's registry is rate-limited per IP and shared with the trade bot.
 *
 * And the one source that cannot be refused was never asked. A pump.fun mint
 * (and a LetsBonk one, and anything minted by the standard tools) carries a
 * Metaplex metadata account whose `uri` names a JSON document holding exactly
 * what the form wants — `website`, `twitter`, `telegram`, `description`,
 * `image`. pump.fun's API reads the same file. That is the Pons lesson one
 * chain over ("the one source that cannot be unreachable — the token contract
 * itself — was the one nobody asked"), and this module is its Solana half.
 *
 * WHAT IT READS, in one RPC request: the mint account and the Metaplex
 * metadata PDA together (`getMultipleAccounts`). A Token-2022 mint carrying
 * its OWN metadata extension (pump.fun's newer mints) is read from the mint;
 * anything else from the Metaplex account. Then the `uri` document, through
 * the guarded fetch (it is a url a stranger typed — see helpers/safeImage) and
 * across the IPFS gateway ladder, because a CID is the hash of the bytes and
 * one gateway's 404 is a fact about that gateway.
 *
 * ⚠️ DISPLAY METADATA ONLY, the contract ponsChain, poolstrade and the
 * launchpad registry carry. No price, no liquidity, no curve — the fields the
 * auto-lister's gates read are deliberately ABSENT, so `mergeInfo` can only
 * ever fill a social hole with this and never a market one.
 *
 * ⚠️ OPT-IN (`discovery.fetchTokenInfoX(…, { chainMeta: true })`), and only the
 * listing form opts in. The auto-lister and the listing audit call the same
 * merge for every candidate on every scan, and they would pay an RPC request
 * and a gateway fetch per token for socials they never render.
 */
const { rpcRead } = require('./config/rpc');
const safeImage = require('./helpers/safeImage');
const ipfs = require('./helpers/ipfsGateways');
const { httpsLogo } = require('./helpers/httpsLogo');
const { safeUrl, socialUrl, description: cleanDescription, str } = require('../../shared/launchpads/normalize');
const log = require('./helpers/logger');

const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// The Token-2022 extension that holds name/symbol/uri INSIDE the mint
// (spl-token-2022 ExtensionType::TokenMetadata).
const EXT_TOKEN_METADATA = 19;
// The mint's base layout is 82 bytes, padded to an Account's 165 so the two
// cannot be confused, then one AccountType byte (1 = Mint), then the TLV list.
const ACCOUNT_TYPE_OFFSET = 165;
const ACCOUNT_TYPE_MINT = 1;
// Metaplex `Key::MetadataV1`.
const METAPLEX_METADATA_V1 = 4;

/** `SOLANA_META=0` turns the source off. Blank is ON (the raid/sourceFlag rule). */
const enabled = () => !/^(0|false|off|no)$/i.test(String(process.env.SOLANA_META == null ? '' : process.env.SOLANA_META).trim());
const covers = (chain) => chain === 'solana' && enabled();

let web3 = null;
function lib() {
  if (web3 === null) {
    try {
      web3 = require('@solana/web3.js');
    } catch {
      web3 = false;
    }
  }
  return web3 || null;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** A borsh String (u32 LE length + UTF-8), or null when it does not fit. */
function readString(buf, off) {
  if (off + 4 > buf.length) return null;
  const len = buf.readUInt32LE(off);
  // A metadata string is a name, a ticker or a url. A length this large is a
  // mis-parse, and reading it would hand a garbage megabyte to the form.
  if (len > 4096 || off + 4 + len > buf.length) return null;
  // Metaplex pads name/symbol/uri with NULs to a fixed width.
  const value = buf.slice(off + 4, off + 4 + len).toString('utf8').replace(/\u0000/g, '').trim();
  return { value, next: off + 4 + len };
}

/**
 * name/symbol/uri from a Metaplex metadata account — and ONLY if it describes
 * THIS mint. The PDA derivation already pins that, and the check costs nothing:
 * a record about another token's mint is the wrong token's socials.
 */
function parseMetaplex(buf, mintBytes) {
  if (!Buffer.isBuffer(buf) || buf.length < 1 + 32 + 32 + 12 || buf[0] !== METAPLEX_METADATA_V1) return null;
  if (mintBytes && !buf.slice(33, 65).equals(mintBytes)) return null;
  const name = readString(buf, 65);
  const symbol = name && readString(buf, name.next);
  const uri = symbol && readString(buf, symbol.next);
  if (!uri) return null;
  return { name: name.value, symbol: symbol.value, uri: uri.value, extra: {}, from: 'metaplex' };
}

/**
 * name/symbol/uri (and the additional key/value pairs, where some mints keep
 * their socials) from a Token-2022 mint's own TokenMetadata extension.
 */
function parseToken2022(buf, mintBytes) {
  if (!Buffer.isBuffer(buf) || buf.length <= ACCOUNT_TYPE_OFFSET + 1 || buf[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) return null;
  let off = ACCOUNT_TYPE_OFFSET + 1;
  while (off + 4 <= buf.length) {
    const type = buf.readUInt16LE(off);
    const len = buf.readUInt16LE(off + 2);
    off += 4;
    if (type === 0 || off + len > buf.length) break; // uninitialised tail, or a torn TLV
    if (type === EXT_TOKEN_METADATA) {
      const v = buf.slice(off, off + len);
      // update authority (32) · mint (32) · name · symbol · uri · additional
      if (v.length < 64 + 12) return null;
      if (mintBytes && !v.slice(32, 64).equals(mintBytes)) return null;
      const name = readString(v, 64);
      const symbol = name && readString(v, name.next);
      const uri = symbol && readString(v, symbol.next);
      if (!uri) return null;
      const extra = {};
      if (uri.next + 4 <= v.length) {
        const n = Math.min(v.readUInt32LE(uri.next), 64);
        let p = uri.next + 4;
        for (let i = 0; i < n; i++) {
          const k = readString(v, p);
          const val = k && readString(v, k.next);
          if (!val) break;
          extra[k.value.toLowerCase()] = val.value;
          p = val.next;
        }
      }
      return { name: name.value, symbol: symbol.value, uri: uri.value, extra, from: 'token-2022' };
    }
    off += len;
  }
  return null;
}

// ── Socials ──────────────────────────────────────────────────────────────────

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const firstText = (...vals) => {
  for (const v of vals) {
    const t = text(v);
    if (t) return t;
  }
  return null;
};
const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** A website, tolerating the bare `binwise.xyz` a creator types into a form. */
function webUrl(v) {
  const s = text(v);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return safeUrl(s);
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s)) return safeUrl(`https://${s}`);
  return null;
}

/**
 * An X or Telegram link — and ONLY if it goes where its label says.
 *
 * ⚠️ A creator types these into a free-text form, and the review card renders
 * them under "X:" and "Telegram:". A `twitter` field holding some other site
 * is a link a buyer taps believing it is the project's X; refusing it costs a
 * blank the form lets them fill, and accepting it costs a mislabelled link on a
 * public listing. So a URL is kept only on the label's own host; a bare handle
 * (`@binwise`, `binwise`) becomes one.
 */
function labelledUrl(v, base, hostRe) {
  const s = text(v);
  if (!s) return null;
  const full = /^https?:\/\//i.test(s) ? s : /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(s) ? `https://${s}` : null;
  if (full) {
    const u = safeUrl(full);
    return u && hostRe.test(hostOf(u)) ? u : null;
  }
  return socialUrl(s, base);
}
const X_HOST = /(^|\.)(x|twitter)\.com$/;
const TG_HOST = /(^|\.)(t\.me|telegram\.me|telegram\.dog)$/;

/**
 * A launchpad stamps its OWN url into `external_url` / `createdOn` on every
 * token it mints. That is where the token was made, not the project's website.
 */
const PLATFORM_HOST = /(^|\.)(pump\.fun|bonk\.fun|letsbonk\.fun|believe\.app|moonshot\.money|raydium\.io|jup\.ag|meteora\.ag|dexscreener\.com|boop\.fun|heaven\.xyz|bags\.fm)$/;

/** Everything the form can use, out of the uri document and the on-chain record. */
function extract(doc, onchain) {
  const j = doc && typeof doc === 'object' ? doc : {};
  const ext = j.extensions && typeof j.extensions === 'object' ? j.extensions : {};
  const links = j.links && typeof j.links === 'object' && !Array.isArray(j.links) ? j.links : {};
  const props = j.properties && typeof j.properties === 'object' ? j.properties : {};
  const extra = (onchain && onchain.extra) || {};

  let website = webUrl(firstText(j.website, ext.website, links.website, props.website, extra.website));
  if (!website) {
    // The Metaplex standard's project url — unless it is the launchpad's own.
    const made = hostOf(webUrl(j.createdOn) || '');
    const cand = webUrl(j.external_url);
    const h = cand && hostOf(cand);
    if (cand && !PLATFORM_HOST.test(h) && h !== made) website = cand;
  }
  return {
    name: str(firstText(onchain && onchain.name, j.name), 60) || null,
    symbol: str(firstText(onchain && onchain.symbol, j.symbol), 24) || null,
    logoUrl: httpsLogo(firstText(j.image, props.image, ext.image)),
    website,
    twitter: labelledUrl(firstText(j.twitter, j.x, ext.twitter, ext.x, links.twitter, links.x, props.twitter, extra.twitter, extra.x), 'https://x.com', X_HOST),
    telegram: labelledUrl(firstText(j.telegram, ext.telegram, links.telegram, props.telegram, extra.telegram), 'https://t.me', TG_HOST),
    description: cleanDescription(typeof j.description === 'string' ? j.description : null),
    source: 'solana-meta',
  };
}

// ── The two reads ────────────────────────────────────────────────────────────

/** One JSON-RPC call against one endpoint. A refusal reads as a TRANSPORT
 *  error, so rpcRead asks the next endpoint: a 401/403/429 is a fact about the
 *  host's bucket, never about the token. */
async function rpcPost(url, method, params, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const refused = res.status === 401 || res.status === 403 || res.status === 429;
    throw new Error(`HTTP ${res.status}${refused ? ' — service unavailable to this server' : ''}`);
  }
  const j = await res.json();
  if (j && j.error) {
    const msg = `rpc ${j.error.code}: ${j.error.message || 'error'}`;
    // A node's own "too many requests" arrives as a JSON-RPC error.
    throw new Error(/rate|too many|limit/i.test(msg) ? `${msg} (rate limit)` : msg);
  }
  return j && j.result;
}

/** Both accounts in ONE request — the metadata PDA and the mint itself. */
async function readAccounts(addrs, { timeoutMs, budgetMs }) {
  const { value } = await rpcRead(
    'solana',
    (url) => rpcPost(url, 'getMultipleAccounts', [addrs, { encoding: 'base64', commitment: 'confirmed' }], timeoutMs),
    { timeoutMs, budgetMs },
  );
  return (value && Array.isArray(value.value) ? value.value : []).map((a) => {
    if (!a || !Array.isArray(a.data)) return null;
    return { owner: a.owner, data: Buffer.from(String(a.data[0] || ''), 'base64') };
  });
}

/**
 * The uri document across the ladder, HEDGED: the next gateway starts after
 * `staggerMs` if the current one is merely slow, a miss starts it at once, the
 * first JSON object wins. A fresh pump.fun CID is a DHT walk on a public
 * gateway, and aborting that walk to restart it elsewhere is the `$DLYN`
 * defect (src/lib/hedge.ts) — so the slow one is left to finish.
 */
function readDocument(uri, { deadlineMs, staggerMs = 1200, fetchJson }) {
  const cands = ipfs.candidates(uri, 4);
  if (!cands.length) return Promise.resolve({ json: null, why: `the metadata uri is not a url (${str(uri, 60) || 'blank'})`, flaky: false });
  return new Promise((resolve) => {
    const started = Date.now();
    const whys = [];
    let i = 0;
    let pending = 0;
    let flaky = false;
    let done = false;
    let stagger = null;
    // ⚠️ NOT unref'd — a caller is waiting on this — and cleared on settle.
    const deadline = setTimeout(() => finish({ json: null, why: `no gateway answered within ${deadlineMs}ms${whys.length ? ` (${whys.join('; ')})` : ''}`, flaky: true }), deadlineMs);
    function finish(v) {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearTimeout(stagger);
      resolve(v);
    }
    function launch() {
      if (done || i >= cands.length) return;
      const u = cands[i++];
      pending++;
      clearTimeout(stagger);
      stagger = setTimeout(launch, staggerMs);
      const left = Math.max(250, deadlineMs - (Date.now() - started));
      Promise.resolve()
        .then(() => fetchJson(u, { timeoutMs: left }))
        .catch((e) => ({ json: null, why: (e && e.message) || String(e), flaky: true }))
        .then((r) => {
          pending--;
          if (done) return;
          if (r && r.json) return finish({ json: r.json, url: u, why: null, flaky: false });
          if (r && r.flaky) flaky = true;
          whys.push((r && r.why) || `${hostOf(u)}: no answer`);
          if (i < cands.length) return launch();
          if (!pending) finish({ json: null, why: whys.join('; '), flaky });
        });
    }
    launch();
  });
}

// ── Public ───────────────────────────────────────────────────────────────────

/** Test seam — the two network reads. */
const _deps = { readAccounts, fetchJson: (u, o) => safeImage.fetchJson(u, o) };

const HIT_TTL_MS = 15 * 60_000;
const CACHE_MAX = 500;
const cache = new Map(); // mint → { at, res }  (ANSWERS only)
const inflight = new Map();
const lastFail = new Map(); // mint → { why, at }

function remember(map, k, v, max) {
  map.delete(k);
  map.set(k, v);
  if (map.size > max) map.delete(map.keys().next().value);
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

async function read(mint, budgetMs) {
  const w = lib();
  if (!w) return { ok: false, why: '@solana/web3.js is not installed', info: null };
  let mintKey;
  let pda;
  try {
    mintKey = new w.PublicKey(mint);
    const prog = new w.PublicKey(METADATA_PROGRAM);
    [pda] = w.PublicKey.findProgramAddressSync([Buffer.from('metadata'), prog.toBuffer(), mintKey.toBuffer()], prog);
  } catch {
    // Not a key at all is an ANSWER about the paste, not a failure to ask.
    return { ok: true, why: 'not a Solana address', info: null };
  }
  const started = Date.now();
  const B = budgetMs > 0 ? budgetMs : 0;
  const rpcTimeout = B ? clamp(Math.round(B * 0.3), 600, 2500) : 4000;
  const rpcBudget = B ? clamp(Math.round(B * 0.4), 800, 3500) : 8000;

  let accts;
  try {
    accts = await _deps.readAccounts([pda.toBase58(), mintKey.toBase58()], { timeoutMs: rpcTimeout, budgetMs: rpcBudget });
  } catch (e) {
    // undici hides the syscall in `err.cause` — "fetch failed" alone cannot
    // tell a dead DNS from a refused socket, and the operator needs which.
    const code = e && e.cause && e.cause.code ? ` (${e.cause.code})` : '';
    return { ok: false, why: `could not read the token's accounts from the Solana RPC (${str((e && e.message) || e, 120)}${code})`, info: null };
  }
  const [metaAcct, mintAcct] = accts;
  const mintBytes = mintKey.toBuffer();
  // The mint's OWN metadata extension first — it is the authority on itself;
  // the Metaplex account is what every other mint has.
  const onchain =
    (mintAcct && mintAcct.owner === TOKEN_2022 && parseToken2022(mintAcct.data, mintBytes)) ||
    (metaAcct && metaAcct.owner === METADATA_PROGRAM && parseMetaplex(metaAcct.data, mintBytes)) ||
    null;
  if (!onchain) {
    // The chain ANSWERED: no metadata account, no extension. A token nobody
    // gave a name to has no socials to find either.
    return { ok: true, why: mintAcct ? 'the mint carries no metadata' : 'no such mint on Solana', info: null };
  }
  const base = extract(null, onchain);
  if (!onchain.uri) return { ok: true, why: 'the metadata names no document', info: base };

  const left = B ? B - (Date.now() - started) - 250 : 10_000;
  if (left < 300) return { ok: false, why: 'no time left to read the metadata document', info: base };
  const doc = await readDocument(onchain.uri, { deadlineMs: left, fetchJson: _deps.fetchJson });
  if (!doc.json) {
    // The on-chain half is still worth having — name and ticker — and the
    // document's failure is said, not swallowed: "the gateway did not answer"
    // and "the project wrote no socials" send an operator different places.
    return { ok: !doc.flaky, why: `metadata document ${doc.flaky ? 'could not be read' : 'is unusable'}: ${str(doc.why, 200)}`, info: base };
  }
  return { ok: true, why: null, info: extract(doc.json, onchain), docUrl: doc.url };
}

/**
 * `{ ok, why, info }`. `ok:false` is "we could not ask" (an RPC or every
 * gateway refusing us) and is never cached; an ANSWER — including "this mint
 * has no metadata" — is remembered for HIT_TTL_MS, and concurrent pastes of
 * one mint share one read.
 */
async function fetchTokenInfoX(chain, mint, opts = {}) {
  if (!covers(chain)) return { ok: true, why: null, info: null };
  const key = String(mint || '').trim();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < HIT_TTL_MS) return hit.res;
  if (inflight.has(key)) return inflight.get(key);
  const budget = Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : 0;
  const p = read(key, budget)
    .catch((e) => ({ ok: false, why: `metadata read crashed: ${str((e && e.message) || e, 120)}`, info: null }))
    .then((res) => {
      if (res.ok) {
        remember(cache, key, { at: Date.now(), res }, CACHE_MAX);
        lastFail.delete(key);
      } else {
        remember(lastFail, key, { why: res.why, at: Date.now() }, 200);
        // At INFO: this is the line that says why a form came back with no
        // socials, and production does not print debug.
        log.info(`[solana-meta] ${key}: ${res.why}`);
      }
      // An ANSWER can still explain an empty form — "the mint carries no metadata".
      if (res.ok && res.why) remember(lastFail, key, { why: res.why, at: Date.now() }, 200);
      return res;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function fetchTokenInfo(chain, mint, opts) {
  return (await fetchTokenInfoX(chain, mint, opts)).info;
}

/** Why the last read of this mint came back short, or null. */
function lastWhy(mint) {
  const f = lastFail.get(String(mint || '').trim());
  if (!f || Date.now() - f.at > HIT_TTL_MS) return null;
  return f.why;
}

const _reset = () => {
  cache.clear();
  inflight.clear();
  lastFail.clear();
};

module.exports = {
  covers,
  enabled,
  fetchTokenInfo,
  fetchTokenInfoX,
  lastWhy,
  METADATA_PROGRAM,
  TOKEN_2022,
  _deps,
  _reset,
  _test: { parseMetaplex, parseToken2022, extract, readDocument, readString, webUrl, labelledUrl, rpcPost },
};
