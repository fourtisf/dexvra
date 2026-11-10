// THE TEST SUITE IS OFFLINE BY CONSTRUCTION — preloaded into every test process
// by scripts/run-tests.js (NODE_OPTIONS --require).
//
// It used to be offline by ACCIDENT. The sandbox this repo is developed in has
// no egress, so a test that forgot to stub a request failed the request fast
// and passed; on a machine WITH internet the same test got a real answer. The
// first CI run proved it: `trendFill.test.js` "what it could NOT do is
// reported" never stubbed the DexScreener fallback, CI's real DexScreener
// answered with MORPHO and VVV, and a test about an UNREADABLE market listed
// two real tokens. A network spy over the whole suite then found thirteen test
// files reaching real hosts — 2,121 DexScreener/GeckoTerminal calls from
// autoTrend.test.js alone. Whether such a test passes is a property of where
// it runs, which is not a test.
//
// So every request to a non-local host fails the way an unreachable network
// fails — fast, as a transport error (`fetch failed` with an ECONNREFUSED
// cause; http/https sockets refused) — on every machine. A test that stubs its
// network is unaffected; a test that does not now behaves identically here, in
// CI and on the server. Local servers (127.0.0.1, localhost, ::1) still work,
// because several tests stand one up on purpose.
//
// Each refused host is recorded to TEST_NET_LOG, and run-tests prints them at
// the end: a leak is visible, never silent. TEST_NETWORK=1 turns the guard off
// for a deliberate live debugging run.
'use strict';
const fs = require('fs');

if (!/^(1|true|on|yes)$/i.test(String(process.env.TEST_NETWORK || '').trim())) {
  const isLocal = (h) => /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|\[::1\])$/i.test(String(h || ''));
  const whoAmI = () => {
    const f = process.argv.find((a) => /\.test\.js$/.test(a));
    return f ? f.replace(/^.*[\\/]test[\\/]/, 'test/') : '(a child process)';
  };
  const seen = new Set();
  const record = (host) => {
    const k = `${whoAmI()}\t${host}`;
    if (seen.has(k) || !process.env.TEST_NET_LOG) return;
    seen.add(k);
    try {
      fs.appendFileSync(process.env.TEST_NET_LOG, `${k}\n`);
    } catch {
      /* the record is a report; it must never fail a test */
    }
  };
  const OFFLINE = 'the test suite is offline (scripts/offline-guard.js)';

  const realFetch = globalThis.fetch;
  if (typeof realFetch === 'function') {
    globalThis.fetch = function offlineFetch(input, init) {
      let host = null;
      try {
        host = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url).hostname;
      } catch {
        /* not an absolute url — the real fetch says why */
      }
      if (host && !isLocal(host)) {
        record(host);
        const cause = Object.assign(new Error(`connect ECONNREFUSED ${host} — ${OFFLINE}`), { code: 'ECONNREFUSED' });
        return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause }));
      }
      return realFetch.apply(this, arguments);
    };
  }

  // http/https: the request is pointed at a closed local port, so the caller
  // gets the ordinary asynchronous ECONNREFUSED 'error' event on a real
  // ClientRequest — a fake request object would be one more thing to get wrong.
  for (const name of ['http', 'https']) {
    const mod = require(name);
    const origRequest = mod.request;
    const rewrite = (args) => {
      let i = 0;
      let url = null;
      if (typeof args[0] === 'string' || args[0] instanceof URL) {
        try {
          url = new URL(String(args[0]));
        } catch {
          return null;
        }
        i = 1;
      }
      const opts = args[i] && typeof args[i] === 'object' && !(args[i] instanceof URL) ? args[i] : null;
      if (opts) i++;
      const cb = typeof args[i] === 'function' ? args[i] : null;
      const host = url ? url.hostname : opts && (opts.hostname || String(opts.host || '').replace(/:\d+$/, ''));
      if (!host || isLocal(host)) return null;
      record(host);
      const merged = { ...(url ? { protocol: url.protocol, path: url.pathname + url.search, method: 'GET' } : {}), ...(opts || {}) };
      Object.assign(merged, { host: '127.0.0.1', hostname: '127.0.0.1', port: 1, agent: false });
      delete merged.socketPath;
      delete merged.lookup;
      delete merged.createConnection;
      delete merged.servername;
      return cb ? [merged, cb] : [merged];
    };
    mod.request = function offlineRequest(...args) {
      return origRequest.apply(this, rewrite(args) || args);
    };
    mod.get = function offlineGet(...args) {
      const req = mod.request.apply(this, args);
      req.end();
      return req;
    };
  }
}
