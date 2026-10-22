'use strict';
/*
 * A TOKEN'S OWN ARTWORK, FROM A HOST OUR IMAGE PROXY WILL NOT SERVE.
 *
 * "mengapa bot free listing without logo pdahl tokenya ada logonya". $W
 * (Wormhole Token, Solana) was free-listed to 12,406 subscribers drawing the
 * Dexvra mark, and the ops channel said exactly why:
 *
 *   [fulfil] logo unusable — proxy answered HTTP 400; banner falls back to the
 *   Dexvra mark: https://wormhole.com/token.png
 *
 * That url is the project's OWN file and it serves a perfectly good PNG.
 * `/api/logo` refused it because wormhole.com is not on its image-host
 * allowlist — and the allowlist is RIGHT to refuse it: that route is a PUBLIC
 * endpoint, and an allowlist is what stops it being an image proxy for the
 * whole internet. But the allowlist was answering a question the bot never
 * needed to ask it. A one-time, server-side copy of a token's own declared
 * artwork, kept on our own disk (`/api/media`), is not a public proxy — and
 * once it is on our disk the site, the banner and every later post read OUR
 * file, so nothing ever has to fetch the stranger's host again.
 *
 * What makes it safe to fetch a url a token creator typed is THIS module, and
 * every rule in it is an SSRF hole if it is dropped:
 *
 *   · https only, on the default port, no credentials in the url;
 *   · the host must resolve to PUBLIC addresses only — and the check is done
 *     INSIDE the connection (a custom `lookup`), not before it, so a name that
 *     answers a public address to the check and 169.254.169.254 to the connect
 *     (DNS rebinding) has nothing to rebind: the address we vetted is the one
 *     the socket uses;
 *   · an IP-literal host is checked directly, because Node never calls
 *     `lookup` for one;
 *   · redirects are followed BY HAND and every hop is re-checked — the rule
 *     /api/logo states about `redirect: "follow"` handing the guard's whole job
 *     to the upstream;
 *   · the body is bounded (the site's own 3 MB upload limit) and the type is
 *     read from the BYTES. SVG is refused: it is a document that can carry
 *     script, and the upload route refuses to keep one anyway.
 *
 * Never throws. `{ bytes, ext, mime, url }` on success; `{ bytes:null, why,
 * flaky }` otherwise — `flaky` says whether asking again later could change the
 * answer (a timeout, a 429, a 5xx) or not (a 404, an HTML page, a private
 * address), because "could not ask" and "nothing there" are different facts.
 */
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');

// The site's `MEDIA_MAX_BYTES` (src/lib/mediaStore.ts). Larger than this and
// the upload route refuses to keep it, so downloading it is wasted bytes.
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_HOPS = 3;
const TIMEOUT_MS = 10_000;

/**
 * `LOGO_GUARDED_FETCH=0` turns the network half off. The test runner does —
 * every test stubs the network, and a test that reaches a refused-host path
 * must not quietly make a real request to a stranger. Tests of THIS module
 * pass their own `request`, which always runs. Blank is ON (the
 * `raid/sourceFlag.js` rule).
 */
const enabled = () => !/^(0|false|off|no)$/i.test(String(process.env.LOGO_GUARDED_FETCH == null ? '' : process.env.LOGO_GUARDED_FETCH).trim());

/** Dotted IPv4 → whether it is anywhere a server-side fetch must never go. */
function v4Reserved(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return true; // this-net, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local — the cloud metadata address
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/**
 * Is this an address a server may fetch from on a stranger's say-so?
 *
 * ⚠️ IPv6 is refused by RANGE rather than allowed by range, and anything this
 * cannot classify is refused: a logo we fail to fetch costs a source, a
 * mis-classified internal address costs the box.
 */
function isPublicAddress(ip) {
  const s = String(ip || '').trim().toLowerCase();
  const fam = net.isIP(s);
  if (fam === 4) return !v4Reserved(s);
  if (fam !== 6) return false;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return !v4Reserved(mapped[1]);
  if (s === '::' || s === '::1') return false;
  if (s.startsWith('::')) return false; // v4-compatible, hex-mapped, unspecified forms
  if (/^f[cd]/.test(s)) return false; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(s)) return false; // fe80::/10 link-local
  if (s.startsWith('ff')) return false; // multicast
  if (s.startsWith('64:ff9b:')) return false; // NAT64 — can translate to a private v4
  if (s.startsWith('2001:db8:') || s === '2001:db8::') return false; // documentation
  return true;
}

/**
 * A `lookup` for https.request that hands the socket PUBLIC addresses only.
 *
 * Node calls it two ways: `{all: true}` (Node 20+, autoSelectFamily) wants an
 * array back; otherwise it wants `(err, address, family)`. Both are honoured,
 * and the private addresses are FILTERED out of the answer rather than merely
 * checked — the connection can only ever use what this returns.
 */
function guardedLookup(lookup = dns.lookup) {
  return function (hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) };
    lookup(hostname, { ...opts, all: true }, (err, addrs) => {
      if (err) return callback(err);
      const ok = (Array.isArray(addrs) ? addrs : []).filter((a) => a && isPublicAddress(a.address));
      if (!ok.length) {
        const e = new Error(`${hostname} resolves only to private or reserved addresses`);
        e.code = 'EPRIVATEADDR';
        return callback(e);
      }
      if (opts.all) return callback(null, ok);
      return callback(null, ok[0].address, ok[0].family);
    });
  };
}

/** Why this url may not be fetched at all, or null. */
function refusal(u) {
  if (u.protocol !== 'https:') return `${u.protocol.replace(/:$/, '')} is not https`;
  if (u.port && u.port !== '443') return `port ${u.port} is not allowed`;
  if (u.username || u.password) return 'credentials in the url';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return 'no host';
  if (net.isIP(host)) return isPublicAddress(host) ? null : `${host} is a private or reserved address`;
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host)) {
    return `${host} is not a public host`;
  }
  return null;
}

/** The image type from its first bytes — the same four the upload route keeps
 *  (src/lib/mediaStore.ts sniffImage), so what passes here is what it stores. */
function sniff(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'webp';
  return null;
}
const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** 3 MB, or 256 KB — never "0 MB" for a bound under a megabyte. */
const sizeLabel = (n) => (n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.round(n / 1024)} KB`);

/** A status that says nothing permanent about the file. */
const flakyStatus = (s) => s === 401 || s === 403 || s === 408 || s === 425 || s === 429 || s >= 500;

/** One request, no redirects followed. Resolves; never rejects. */
function once(u, { request, lookup, timeoutMs, maxBytes, accept = 'image/*', refuseType = /^text\/|html|json/ }) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    // ⚠️ NOT unref'd: a caller is awaiting this, and an unref'd timer lets a
    // process with nothing else pending exit with that caller hung for ever.
    const timer = setTimeout(() => {
      done({ fail: `no answer after ${timeoutMs}ms`, flaky: true });
      if (req) req.destroy();
    }, timeoutMs);
    try {
      req = request(
        u,
        {
          method: 'GET',
          lookup: guardedLookup(lookup),
          // Its own socket, never a pooled one: a pooled socket was connected
          // by whoever opened it, and this module vouches only for its own.
          agent: false,
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; DexvraLogo/1.0)', accept },
        },
        (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            return done({ redirect: String(res.headers.location) });
          }
          if (status < 200 || status >= 300) {
            res.resume();
            return done({ fail: `HTTP ${status}`, flaky: flakyStatus(status) });
          }
          const type = String(res.headers['content-type'] || '').toLowerCase();
          // A 200 carrying HTML is a CDN's way of not admitting a miss.
          if (refuseType.test(type)) {
            res.resume();
            return done({ fail: `served ${type.split(';')[0]}`, flaky: false });
          }
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) {
            res.resume();
            return done({ fail: `larger than ${sizeLabel(maxBytes)}`, flaky: false });
          }
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size > maxBytes) {
              done({ fail: `larger than ${sizeLabel(maxBytes)}`, flaky: false });
              res.destroy();
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => done({ bytes: Buffer.concat(chunks) }));
          res.on('error', (e) => done({ fail: `body died: ${(e && e.code) || (e && e.message) || 'error'}`, flaky: true }));
        },
      );
      req.on('error', (e) => {
        // A private address is a fact about the HOST, not a bad minute.
        const priv = e && e.code === 'EPRIVATEADDR';
        done({ fail: priv ? e.message : `could not reach: ${(e && e.code) || (e && e.message) || 'error'}`, flaky: !priv });
      });
      req.end();
    } catch (e) {
      done({ fail: `could not request: ${(e && e.message) || e}`, flaky: false });
    }
  });
}

/**
 * Walk one url's redirects under the guard, and hand the final body to
 * `finish(bytes, url)`. The ONE hop loop: an image and a metadata document are
 * fetched under exactly the same rules, and a second copy of this loop is how
 * one of them would come to skip the per-hop re-check.
 */
async function guarded(raw, opts, kind, finish) {
  const request = opts.request || https.request;
  const lookup = opts.lookup || dns.lookup;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : TIMEOUT_MS;
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : kind.maxBytes;
  const fail = (why, flaky) => ({ ...kind.empty, url: null, why, flaky: !!flaky });
  if (!opts.request && !enabled()) return fail('the guarded fetch is off (LOGO_GUARDED_FETCH=0)', false);
  let u;
  try {
    u = new URL(String(raw == null ? '' : raw).trim());
  } catch {
    return fail('not a url', false);
  }
  const started = Date.now();
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    // Re-checked on EVERY hop: a public host answering `302 https://10.0.0.5/`
    // must not get us to fetch the address it names.
    const bad = refusal(u);
    if (bad) return fail(bad, false);
    const left = Math.max(250, timeoutMs * (MAX_HOPS + 1) - (Date.now() - started));
    const r = await once(u, { request, lookup, timeoutMs: Math.min(timeoutMs, left), maxBytes, accept: kind.accept, refuseType: kind.refuseType });
    if (r.redirect) {
      try {
        u = new URL(r.redirect, u);
      } catch {
        return fail('redirect to an unparseable location', false);
      }
      continue;
    }
    if (!r.bytes) return fail(`${u.hostname}: ${r.fail}`, r.flaky);
    return finish(r.bytes, u, fail);
  }
  return fail(`more than ${MAX_HOPS} redirects`, false);
}

const IMAGE = {
  accept: 'image/*',
  refuseType: /^text\/|html|json/,
  maxBytes: MAX_BYTES,
  empty: { bytes: null, ext: null, mime: null },
};

/**
 * Fetch one image, guarded. See the header.
 *
 * @param {string} raw the url
 * @param {object} [opts] `request` / `lookup` are the test seams (https.request,
 *   dns.lookup); `timeoutMs` bounds EACH hop and `deadlineMs` the whole fetch.
 */
async function fetchImage(raw, opts = {}) {
  return guarded(raw, opts, IMAGE, (bytes, u, fail) => {
    const ext = sniff(bytes);
    if (!ext) return fail(`${u.hostname}: not a PNG, JPG, GIF or WEBP image`, false);
    return { bytes, ext, mime: MIME[ext], url: u.toString(), why: null, flaky: false };
  });
}

/**
 * A token's METADATA DOCUMENT — the JSON its `uri` names — under the same
 * guard. It is exactly as much a stranger's url as a logo is: anyone can mint
 * a token on a permissionless launchpad and point its uri at
 * `http://169.254.169.254/`, so it gets every rule above and nothing less.
 *
 * Only HTML is refused by type. Gateways serve a metadata file as
 * `application/json`, `text/plain` and `application/octet-stream` alike, and
 * the PARSE is the real test: anything that is not a JSON object is an answer
 * about the file (not flaky), never a bad minute. 256 KB — a launchpad's
 * metadata is a few hundred bytes, and a document a thousand times that is
 * not one.
 */
const JSON_DOC = {
  accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
  refuseType: /html/,
  maxBytes: 256 * 1024,
  empty: { json: null },
};

async function fetchJson(raw, opts = {}) {
  return guarded(raw, opts, JSON_DOC, (bytes, u, fail) => {
    let json = null;
    try {
      json = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
      return fail(`${u.hostname}: not a JSON document`, false);
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return fail(`${u.hostname}: not a JSON object`, false);
    return { json, url: u.toString(), why: null, flaky: false };
  });
}

module.exports = { fetchImage, fetchJson, isPublicAddress, guardedLookup, refusal, sniff, enabled, MIME, MAX_BYTES, MAX_HOPS };
