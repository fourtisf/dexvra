import { CHAINS } from "@/config/chains";
import type { ScanCheck, ScanResult } from "@/lib/types";

// Best-effort safety snapshot: GoPlus for EVM chains, RugCheck for Solana.
// Both have free unauthenticated tiers; failures surface as "unavailable"
// checks, never as a fabricated verdict. Per the handoff: never claim
// "100% safe" — verdict copy always keeps the DYOR disclaimer.

function detectChain(address: string): string | null {
  for (const c of Object.values(CHAINS)) {
    if (c.addressPattern.test(address)) return c.id;
  }
  return null;
}

function verdictFor(checks: ScanCheck[]): { verdict: "ok" | "warn"; verdictText: string } {
  const flagged = checks.some((c) => c.status !== "ok");
  return flagged
    ? { verdict: "warn", verdictText: "⚠️ Caution — review the flags before aping." }
    : { verdict: "ok", verdictText: "🛡️ Looks clean — still DYOR, always." };
}

async function scanEvm(chainId: string, address: string): Promise<ScanCheck[]> {
  const goPlusId = CHAINS[chainId].goPlusChainId;
  if (!goPlusId) throw new Error(`no GoPlus coverage for ${chainId}`);
  const res = await fetch(
    `https://api.gopluslabs.io/api/v1/token_security/${goPlusId}?contract_addresses=${address}`,
    { signal: AbortSignal.timeout(9000), cache: "no-store" },
  );
  if (!res.ok) throw new Error(`GoPlus ${res.status}`);
  const json = (await res.json()) as {
    result?: Record<string, Record<string, unknown>>;
  };
  const r = json.result?.[address.toLowerCase()];
  if (!r) throw new Error("GoPlus: token not found");

  const pct = (v: unknown) => Math.round(Number(v ?? 0) * 100);
  const isHoneypot = r.is_honeypot === "1";
  const openSource = r.is_open_source === "1";
  const ownerRenounced =
    r.owner_address === "" || r.owner_address === "0x0000000000000000000000000000000000000000";
  const buyTax = pct(r.buy_tax);
  const sellTax = pct(r.sell_tax);
  const lpLocked = pct(r.lp_locked_percent ?? r.percent_of_lp_locked ?? 0);

  return [
    { label: "Honeypot check", value: isHoneypot ? "HONEYPOT" : "CLEAR", status: isHoneypot ? "bad" : "ok" },
    { label: "Contract open source", value: openSource ? "YES" : "NO", status: openSource ? "ok" : "warn" },
    { label: "Ownership renounced", value: ownerRenounced ? "YES" : "NO", status: ownerRenounced ? "ok" : "warn" },
    { label: "Buy / sell tax", value: `${buyTax}% / ${sellTax}%`, status: buyTax < 2 && sellTax < 2 ? "ok" : "warn" },
    { label: "LP locked", value: lpLocked > 0 ? `${lpLocked}%` : "UNKNOWN", status: lpLocked >= 50 ? "ok" : "warn" },
  ];
}

async function scanSolana(address: string): Promise<ScanCheck[]> {
  const res = await fetch(
    `https://api.rugcheck.xyz/v1/tokens/${address}/report/summary`,
    { signal: AbortSignal.timeout(9000), cache: "no-store" },
  );
  if (!res.ok) throw new Error(`RugCheck ${res.status}`);
  const json = (await res.json()) as {
    score?: number;
    risks?: { name: string; level: string; description?: string }[];
  };
  const risks = json.risks ?? [];
  const danger = risks.filter((r) => r.level === "danger");
  const warn = risks.filter((r) => r.level === "warn");
  const checks: ScanCheck[] = [
    {
      label: "RugCheck risk score",
      value: json.score != null ? String(json.score) : "N/A",
      status: (json.score ?? 0) <= 1000 ? "ok" : "warn",
    },
    {
      label: "Danger flags",
      value: danger.length ? danger.map((r) => r.name).join(", ") : "NONE",
      status: danger.length ? "bad" : "ok",
    },
    {
      label: "Warning flags",
      value: warn.length ? String(warn.length) : "NONE",
      status: warn.length > 2 ? "warn" : "ok",
    },
  ];
  return checks;
}

export async function scanToken(address: string): Promise<ScanResult> {
  const chain = detectChain(address);
  let checks: ScanCheck[];
  let live = true;

  try {
    if (chain === "solana") {
      checks = await scanSolana(address);
    } else if (chain && CHAINS[chain].goPlusChainId) {
      checks = await scanEvm(chain, address);
    } else {
      throw new Error("no scanner coverage");
    }
  } catch {
    live = false;
    checks = [
      { label: "Live scan", value: "UNAVAILABLE", status: "warn" },
      { label: "Address format", value: chain ? CHAINS[chain].label : "UNRECOGNIZED", status: chain ? "ok" : "warn" },
    ];
  }

  const { verdict, verdictText } = live
    ? verdictFor(checks)
    : { verdict: "warn" as const, verdictText: "⚠️ Scanner unavailable right now — DYOR before aping." };

  return { address, chain, checks, verdict, verdictText, live };
}
