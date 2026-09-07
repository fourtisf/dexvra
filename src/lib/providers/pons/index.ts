// Pons v2 provider — the app's only source of market data for Robinhood Chain.
//
// Pons publishes no HTTP API: the launch factory and the per-launch bonding
// curves are the source of truth, so everything here is read straight off the
// chain over JSON-RPC (see config/pons.ts for the deployment constants).
import { CHAINS } from "@/config/chains";
import { PONS } from "@/config/pons";
import type { ScanFlag } from "@/lib/types";
import { readLaunchSnapshots } from "./contracts";

export { fetchPonsMarket, fetchPonsLaunch, fetchPonsTrades, nativeUsd } from "./market";
export type { PonsLaunchInfo } from "./market";

/** True when this chain's market data comes from the Pons launchpad. */
export const isPonsChain = (chain: string): boolean => CHAINS[chain]?.launchpad === "pons-v2";

/** Chains this provider covers, in Dexvra's chain ids. */
export const ponsChains = (): string[] =>
  Object.values(CHAINS).filter((c) => c.launchpad === "pons-v2").map((c) => c.id);

// ── Scanner ───────────────────────────────────────────────────────────────
// A Pons launch is unusually legible: the supply is fixed and minted entirely
// to the curve, the deployer holds no privileges over the token, and a
// graduated position is locked with no withdrawal path in the locker. These
// are contract facts, not heuristics — but the verdict still says DYOR.
export interface PonsSafety {
  fps: { flag: ScanFlag; penalty: number }[];
  chain: string;
  source: string;
  name: string | null;
  symbol: string | null;
}

const info = (label: string, value: string): { flag: ScanFlag; penalty: number } => ({
  flag: { label, value, status: "ok" },
  penalty: 0,
});

export async function scanPonsToken(address: string): Promise<PonsSafety | null> {
  const snapshots = await readLaunchSnapshots([address]);
  const snapshot = snapshots.get(address.toLowerCase());
  if (!snapshot) return null;

  const { launch, curve, meta } = snapshot;
  const taxPct = launch.creatorTaxBps / 100;
  const onCurve = launch.phase === "NotGraduated";

  const fps: { flag: ScanFlag; penalty: number }[] = [
    info("Launchpad", "Pons v2"),
    info("Mintable", "No"),
    info("Owner privileges", "None"),
    {
      flag: {
        label: "Liquidity",
        value: launch.phase === "PoolCreated" ? "Locked permanently" : onCurve ? "Bonding curve" : "Migrating",
        status: launch.phase === "PoolCreated" ? "ok" : onCurve ? "ok" : "warn",
      },
      penalty: launch.phase === "PoolCreated" || onCurve ? 0 : 8,
    },
    {
      flag: {
        label: "Creator tax",
        value: `${taxPct.toFixed(1)}%`,
        status: taxPct < 5 ? "ok" : taxPct < 10 ? "warn" : "bad",
      },
      penalty: taxPct < 5 ? 0 : Math.min(30, Math.round(taxPct * 2)),
    },
    {
      flag: { label: "Graduation", value: launch.phase, status: launch.phase === "Rescued" ? "warn" : "ok" },
      penalty: launch.phase === "Rescued" ? 10 : 0,
    },
    info("Buyback vault", launch.buybackEnabled ? "Enabled" : "Disabled"),
  ];

  if (onCurve && curve) {
    const threshold = launch.graduationThreshold;
    const progress = threshold > 0n ? Number((curve.realQuoteReserve * 10000n) / threshold) / 100 : 0;
    fps.push(info("Curve progress", `${Math.min(100, progress).toFixed(1)}%`));
  }

  return {
    fps,
    chain: PONS.chain,
    source: "Pons v2 (on-chain)",
    name: meta?.name || null,
    symbol: meta?.symbol || null,
  };
}
