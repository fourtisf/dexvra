// The guarded direct image fetch — the one way the bot may read a logo from a
// host /api/logo's allowlist refuses (`$W`: https://wormhole.com/token.png).
//
// Driven, never read: every rule here is an SSRF hole if it is dropped, and a
// source scan cannot tell a guard from a comment about one. `request` and
// `lookup` are the seams — the fake request below CALLS the lookup it was
// handed exactly as Node's socket layer does, so the private-address filter is
// exercised on the path a real connection takes.
const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");

const si = require("../src/helpers/safeImage");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);

/**
 * A fake https.request. `routes[url]` = { status, headers, body, addrs } where
 * `addrs` is what DNS answers for the host. Records every url requested.
 */
function fakeNet(routes) {
  const asked = [];
  const lookup = (host, opts, cb) => {
    const r = Object.values(routes).find((x) => new URL(x.url).hostname === host);
    const addrs = (r && r.addrs) || [{ address: "93.184.216.34", family: 4 }];
    cb(null, addrs);
  };
  const request = (u, opts, cb) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      const url = String(u);
      asked.push(url);
      const r = routes[url];
      // Node calls lookup for a hostname (never for an IP literal) BEFORE it
      // connects — the guard runs here, on the connection path.
      const host = new URL(url).hostname;
      opts.lookup(host, {}, (err) => {
        if (err) return req.emit("error", err);
        if (!r) return req.emit("error", Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
        const res = Readable.from(r.body ? [r.body] : []);
        res.statusCode = r.status || 200;
        res.headers = r.headers || {};
        cb(res);
      });
    };
    return req;
  };
  return { request, lookup, asked };
}

const route = (url, o = {}) => ({ [url]: { url, ...o } });

test("a project's own PNG on a host the proxy refuses is fetched — the $W case", async () => {
  const net = fakeNet(route("https://wormhole.com/token.png", { headers: { "content-type": "image/png" }, body: PNG }));
  const r = await si.fetchImage("https://wormhole.com/token.png", net);
  assert.ok(r.bytes, `expected bytes, got ${r.why}`);
  assert.strictEqual(r.ext, "png");
  assert.strictEqual(r.mime, "image/png");
});

test("the type is read from the BYTES — octet-stream JPG is accepted, an SVG is not", async () => {
  const jpg = await si.fetchImage("https://a.example.com/l", fakeNet(route("https://a.example.com/l", { headers: { "content-type": "application/octet-stream" }, body: JPG })));
  assert.strictEqual(jpg.ext, "jpg");
  const svg = await si.fetchImage(
    "https://a.example.com/s.svg",
    fakeNet(route("https://a.example.com/s.svg", { headers: { "content-type": "image/svg+xml" }, body: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>x</script></svg>") })),
  );
  assert.strictEqual(svg.bytes, null, "an SVG is a document that can carry script, and the upload route keeps nothing but raster images");
  assert.strictEqual(svg.flaky, false, "that is an answer about the file, not a bad minute");
});

test("an HTML page served with a 200 is a miss, not an image", async () => {
  const r = await si.fetchImage("https://a.example.com/x.png", fakeNet(route("https://a.example.com/x.png", { headers: { "content-type": "text/html" }, body: Buffer.from("<html>") })));
  assert.strictEqual(r.bytes, null);
  assert.match(r.why, /served text\/html/);
});

test("http, an odd port, credentials, localhost and a private IP literal are refused before any request", async () => {
  for (const [url, re] of [
    ["http://wormhole.com/token.png", /not https/],
    ["https://wormhole.com:8443/token.png", /port 8443/],
    ["https://u:p@wormhole.com/token.png", /credentials/],
    ["https://localhost/x.png", /not a public host/],
    ["https://169.254.169.254/latest/meta-data", /private or reserved/],
    ["https://[::1]/x.png", /private or reserved/],
    ["https://10.0.0.5/x.png", /private or reserved/],
  ]) {
    const net = fakeNet({});
    const r = await si.fetchImage(url, net);
    assert.strictEqual(r.bytes, null, url);
    assert.match(r.why, re, `${url} → ${r.why}`);
    assert.strictEqual(net.asked.length, 0, `${url} must be refused WITHOUT a request`);
  }
});

test("⚠️ a host that RESOLVES to a private address is refused on the connection path (DNS rebinding has nothing to rebind)", async () => {
  const net = fakeNet(route("https://evil.example.com/x.png", { addrs: [{ address: "169.254.169.254", family: 4 }], body: PNG }));
  const r = await si.fetchImage("https://evil.example.com/x.png", net);
  assert.strictEqual(r.bytes, null);
  assert.match(r.why, /private or reserved/);
  assert.strictEqual(r.flaky, false, "a private address is a fact about the host, not a bad minute");
});

test("a host with mixed answers connects ONLY to its public ones", async () => {
  const handed = [];
  const lookupFn = si.guardedLookup((host, opts, cb) =>
    cb(null, [{ address: "10.0.0.9", family: 4 }, { address: "93.184.216.34", family: 4 }, { address: "fd00::1", family: 6 }]),
  );
  await new Promise((r) => lookupFn("mixed.example.com", { all: true }, (err, addrs) => (handed.push(...addrs), r())));
  assert.deepStrictEqual(handed.map((a) => a.address), ["93.184.216.34"]);
  // …and the non-`all` form Node 18 uses.
  const single = await new Promise((r) => lookupFn("mixed.example.com", {}, (err, addr, fam) => r({ addr, fam })));
  assert.deepStrictEqual(single, { addr: "93.184.216.34", fam: 4 });
});

test("⚠️ every redirect hop is re-checked — a public host bouncing to the metadata address is refused", async () => {
  const net = fakeNet({
    ...route("https://cdn.example.com/a.png", { status: 302, headers: { location: "https://169.254.169.254/latest" } }),
  });
  const r = await si.fetchImage("https://cdn.example.com/a.png", net);
  assert.strictEqual(r.bytes, null);
  assert.match(r.why, /private or reserved/);
  assert.deepStrictEqual(net.asked, ["https://cdn.example.com/a.png"], "the private hop must never be requested");
});

test("an ordinary redirect to a public host is followed", async () => {
  const net = fakeNet({
    ...route("https://cdn.example.com/a.png", { status: 301, headers: { location: "/b.png" } }),
    ...route("https://cdn.example.com/b.png", { headers: { "content-type": "image/png" }, body: PNG }),
  });
  const r = await si.fetchImage("https://cdn.example.com/a.png", net);
  assert.ok(r.bytes);
  assert.strictEqual(r.url, "https://cdn.example.com/b.png");
});

test("a body over the bound is refused, declared or not", async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(2000, 3)]);
  const declared = await si.fetchImage(
    "https://a.example.com/x.png",
    { ...fakeNet(route("https://a.example.com/x.png", { headers: { "content-length": "999999999" }, body: big })), maxBytes: 1000 },
  );
  assert.match(declared.why, /larger than/);
  const streamed = await si.fetchImage("https://a.example.com/x.png", { ...fakeNet(route("https://a.example.com/x.png", { body: big })), maxBytes: 1000 });
  assert.match(streamed.why, /larger than/);
});

test("a 404 is an answer; a 429 or a 503 is not", async () => {
  const miss = await si.fetchImage("https://a.example.com/x.png", fakeNet(route("https://a.example.com/x.png", { status: 404 })));
  assert.strictEqual(miss.flaky, false);
  for (const status of [429, 503]) {
    const r = await si.fetchImage("https://a.example.com/x.png", fakeNet(route("https://a.example.com/x.png", { status })));
    assert.strictEqual(r.flaky, true, `${status} says nothing permanent about the file`);
  }
});

test("isPublicAddress: the ranges a server must never fetch from on a stranger's say-so", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "garbage"]) {
    assert.strictEqual(si.isPublicAddress(ip), false, ip);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::6810:84e5", "::ffff:93.184.216.34"]) {
    assert.strictEqual(si.isPublicAddress(ip), true, ip);
  }
});

test("LOGO_GUARDED_FETCH=0 makes no request at all (the suite's offline guarantee)", async () => {
  const had = process.env.LOGO_GUARDED_FETCH;
  process.env.LOGO_GUARDED_FETCH = "0";
  try {
    const r = await si.fetchImage("https://wormhole.com/token.png");
    assert.strictEqual(r.bytes, null);
    assert.match(r.why, /off/);
  } finally {
    if (had == null) delete process.env.LOGO_GUARDED_FETCH;
    else process.env.LOGO_GUARDED_FETCH = had;
  }
});

test("the sniff keeps exactly what the site's upload route keeps (mediaStore.sniffImage)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const site = fs.readFileSync(path.join(__dirname, "..", "..", "src", "lib", "mediaStore.ts"), "utf8");
  // The four types, in both files — a fifth here would pass bytes the upload
  // then refuses, and a missing one would drop a logo the site would keep.
  for (const t of ["png", "jpg", "gif", "webp"]) assert.match(site, new RegExp(`return "${t}"`), t);
  assert.strictEqual(si.sniff(PNG), "png");
  assert.strictEqual(si.sniff(JPG), "jpg");
  assert.strictEqual(si.sniff(Buffer.from("GIF89a" + "x".repeat(20))), "gif");
  assert.strictEqual(si.sniff(Buffer.from("RIFF0000WEBPVP8 " + "x".repeat(10))), "webp");
  assert.strictEqual(si.sniff(Buffer.from("<svg xmlns='x'></svg>")), null);
});
