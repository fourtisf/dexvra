/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: { unoptimized: true },
  // src/instrumentation.ts — the boot line. Next 14.2 still gates register()
  // behind this flag; without it the file is silently ignored, which is the
  // same failure mode as the banner it replaces.
  experimental: { instrumentationHook: true },
  // Baseline response headers, on every route. Deliberately NOT a full
  // Content-Security-Policy: the pages load Google Fonts, inline JSON-LD and a
  // DexScreener embed, and a CSP that blocks one of them breaks the site in a
  // way only a browser shows. What is here cannot break a page:
  //   · frame-ancestors / X-Frame-Options — nobody may frame dexvra.io or the
  //     admin panel (clickjacking a logged-in admin is the case that matters);
  //   · nosniff — a response is what its content-type says it is;
  //   · HSTS — the site is served over TLS, so a browser that has seen it once
  //     never tries plain http again. No includeSubDomains: a subdomain this
  //     repo does not know about must not be forced onto https by it.
  async headers() {
    return [
      {
        // The CSP is for PAGES only: /api/logo and /api/media send a stricter
        // sandbox CSP of their own, and a config header must not replace it.
        source: "/((?!api/).*)",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'self'" }],
      },
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=15552000" },
        ],
      },
    ];
  },
};

export default nextConfig;
