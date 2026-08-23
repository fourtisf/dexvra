/**
 * The web app's BOOT LINE — what `dexvra-bot` and `dexvra-tradebot` have always
 * printed and the site never did.
 *
 * The release flow in CLAUDE.md ends with "verify what is running before
 * believing anything about it", and every process prints its commit at boot —
 * except this one, which is exactly the process whose deploy has now twice been
 * mistaken for a code fault (a stale remote ref merged as a no-op, then a
 * banner that only printed once a request happened to import its module).
 *
 * Next 14 calls `register()` ONCE per server start when
 * `experimental.instrumentationHook` is on. It also runs during `next build`,
 * which is harmless and is why the sha is printed rather than assumed.
 */
export async function register(): Promise<void> {
  // The hook runs in the edge runtime too; printing there would double the line
  // and the GT client is node-only anyway.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  console.log(`[boot] build ${process.env.NEXT_PUBLIC_BUILD || "unknown"} · node ${process.version} · pid ${process.pid}`);
  const { gtBanner } = await import("./lib/providers/gt");
  gtBanner();
}
