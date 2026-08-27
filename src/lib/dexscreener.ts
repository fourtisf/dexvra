import { CHAINS } from "@/config/chains";

// Pure DexScreener URL builders. No fetching here on purpose: both the server
// provider and client components need these, and keeping them dependency-free
// stops the provider's fetch code from being pulled into the client bundle.

/** DexScreener's chain id for one of our chains, or null when it doesn't
 *  index the chain (no chart, no logo CDN — the caller degrades). */
export const dexChain = (chainId: string): string | null =>
  CHAINS[chainId]?.dexscreenerChain ?? null;

/** DexScreener keys EVM tokens by their lowercased address but non-EVM ones
 *  (Solana base58, TON, Tron) by their exact address, so only 0x-addresses
 *  may be case-folded. */
const cdnKey = (address: string): string =>
  address.startsWith("0x") ? address.toLowerCase() : address;

/** Public CDN path DexScreener serves every indexed token's logo from.
 *  Deterministic, so it works as a fallback when an API response happens to
 *  omit `info.imageUrl`. `size` "lg" is the ~256px variant. */
export function dexLogoUrl(
  chainId: string,
  address: string,
  size?: "lg",
): string | null {
  const chain = dexChain(chainId);
  if (!chain || !address) return null;
  const base = `https://dd.dexscreener.com/ds-data/tokens/${chain}/${cdnKey(address)}.png`;
  return size ? `${base}?size=${size}` : base;
}

/** Canonical DexScreener page for a token — resolves to its top pair. */
export function dexTokenUrl(chainId: string, address: string): string | null {
  const chain = dexChain(chainId);
  if (!chain || !address) return null;
  return `https://dexscreener.com/${chain}/${address}`;
}

/** Embeddable chart for a pair, falling back to the token address (which
 *  DexScreener resolves to the token's top pair) when we haven't resolved a
 *  pool yet. Null when the chain isn't on DexScreener at all. */
export function dexEmbedUrl(
  chainId: string,
  address: string,
  poolAddress?: string | null,
): string | null {
  const chain = dexChain(chainId);
  const target = poolAddress || address;
  if (!chain || !target) return null;
  const q = new URLSearchParams({
    embed: "1",
    theme: "dark",
    chartTheme: "dark",
    // Dexvra renders its own transactions panel and token header below the
    // chart, so the embed's own tabs/trades/info chrome is redundant.
    trades: "0",
    info: "0",
    tabs: "0",
    chartLeftToolbar: "0",
    chartDefaultOnMobile: "1",
    // Price in USD, candles, 15m — matches how the board quotes everything.
    chartType: "usd",
    chartStyle: "1",
    interval: "15",
    // Ignore whatever the visitor last set on dexscreener.com so every
    // Dexvra token page opens identically.
    loadChartSettings: "0",
  });
  return `https://dexscreener.com/${chain}/${target}?${q.toString()}`;
}
