"use strict";
/**
 * The IPFS gateway ladder, for the bot — a PORT of src/lib/ipfsGateways.ts.
 *
 * The site owns the list: `/api/logo` and the logo resolver both read it, and
 * the bot never needed its own because every logo it fetches goes THROUGH
 * `/api/logo`. A token's metadata DOCUMENT does not: it is JSON, the proxy
 * serves images only, and the Solana metadata reader (solanaMeta.js) has to
 * fetch it itself. This package is CommonJS on Node 18 and cannot import a .ts
 * module, so it carries a copy — and a copy is a second owner, which is how
 * pump.fun's own pin came to be allowlisted in one place and missing from the
 * other (the $GG round). `ipfsGatewaysPort.test.js` reads the TS source and
 * fails if the two default lists ever disagree.
 *
 * Same env override as the site's: `IPFS_GATEWAYS` (comma list) REPLACES the
 * defaults, so an operator who moves the ladder moves it for both processes
 * with one line in each `.env`.
 */
const DEFAULTS = [
  "https://ipfs.io/ipfs/",
  "https://pump.mypinata.cloud/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://w3s.link/ipfs/",
  "https://dweb.link/ipfs/",
  "https://nftstorage.link/ipfs/",
];

function gateways() {
  const listed = String(process.env.IPFS_GATEWAYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return listed.length ? listed : DEFAULTS.slice();
}

/** The `<cid>/<path…>` of an IPFS url, or null — both spellings, and the
 *  subdomain one, exactly as the site reads them. */
function ipfsPath(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (/^ipfs:\/\//i.test(s)) {
    const p = s.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//i, "");
    return p || null;
  }
  const m = /^https?:\/\/[^/]+\/ipfs\/(.+)$/i.exec(s);
  if (m) return m[1];
  const sub = /^https?:\/\/(b[a-z2-7]{50,})\.ipfs\.[^/]+(\/[^?#]*)?/i.exec(s);
  if (!sub) return null;
  const path = (sub[2] || "").replace(/^\/+/, "");
  return path ? `${sub[1].toLowerCase()}/${path}` : sub[1].toLowerCase();
}

/**
 * Every url worth trying for one IPFS document, ladder order — the url the
 * CALLER named first (a working gateway must not be demoted), then the others
 * with the same CID. A non-IPFS url is returned on its own: its 404 IS an
 * answer, and it has no ladder. `ipfs://` is never returned as-is.
 */
function candidates(raw, max = Infinity) {
  const s = String(raw == null ? "" : raw).trim();
  const cid = ipfsPath(s);
  if (!cid) return /^https?:\/\//i.test(s) ? [s] : [];
  const out = [];
  if (/^https?:\/\//i.test(s)) out.push(s);
  for (const gw of gateways()) {
    if (out.length >= max) break;
    const u = gw.replace(/\/*$/, "/") + cid;
    if (!out.includes(u)) out.push(u);
  }
  return out.slice(0, max);
}

module.exports = { DEFAULTS, gateways, ipfsPath, candidates };
