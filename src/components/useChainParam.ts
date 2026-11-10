"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * The pages whose board takes a chain filter. The rail's chain links target
 * the page you are ON when it is one of these — clicking "Solana" on Gainers &
 * Losers filters Gainers & Losers — and the home board otherwise.
 */
export const CHAIN_PAGES: readonly string[] = ["/", "/trending", "/leaderboard"];

/**
 * The chain filter, kept in the URL (`?chain=`).
 *
 * ⚠️ ONE STATE, NOT ONE PER CONTROL. The rail (desktop) and the chain row
 * (below 1100px) are two controls for one filter; a `useState("all")` in each
 * page is how they came to disagree — the rail said Solana while the page's own
 * chips said All chains, and the trending page wrapped its chips into a second
 * design of the same row. Reading and writing the parameter makes them one
 * control in two places, and a filtered board is a link somebody can share.
 *
 * `replace`, never `push`: a filter is not a page, and Back should leave the
 * board rather than step through every chip that was tapped.
 */
export function useChainParam(): [string, (id: string) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const chain = params.get("chain") ?? "all";
  const setChain = (id: string) =>
    router.replace(id === "all" ? pathname : `${pathname}?chain=${encodeURIComponent(id)}`, { scroll: false });
  return [chain, setChain];
}
