import { CHAINS } from "@/config/chains";
import type { ScanCheck, ScanResult } from "@/lib/types";

// Best-effort safety snapshot: GoPlus for EVM chains, RugCheck for Solana.
// Both have free unauthenticated tiers; failures surface as "unavailable"
// checks, never as a fabricated verdict. Per the handoff: never claim
// "100% safe" — verdict copy always keeps the DYOR disclaimer.

const isEvmAddress = (a: string) => /^0x[a-fA-F0-9]{40}$/.test(a);

// A bare EVM address is chain-ambiguous (Base/Ethereum/BSC share the 0x…40
// format), so we can't pick a single GoPlus chain id up front. Solana (base58,
// never starts with 0x) and TON (EQ/UQ/0: prefix) are unambiguous.
function detectFamily(address: string): "solana" | "evm" | "ton" | null {
  if (CHAINS.solana.addressPattern.test(address)) return "solana";
  if (isEvmAddress(address)) return "evm";
  if (CHAINS.ton.addressPattern.test(address)) return "ton";
  return null;
}

function verdictFor(checks: ScanCheck[]): { verdict: "ok" | "warn"; verdictText: string } {
  const flagged = checks.some((c) => c.status !== "ok");
  return flagged
    ? { verdict: "warn", verdictText: "⚠️ Caution — review the flags before aping." }
    : { verdict: "ok", verdictText: "🛡️ Looks clean — still DYOR, always." };
}

async function goPlusLookup(goPlusId: string, address: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(
    `https://api.gopluslabs.io/api/v1/token_security/${goPlusId}?contract_addresses=${address}`,
    { signal: AbortSignal.timeout(9000), cache: "no-store" },
  );
  if (!res.ok) throw new Error(`GoPlus ${res.status}`);
  const json = (await res.json()) as {
    result?: Record<string, Record<string, unknown>>;
  };
  // GoPlus returns an empty object (not an error) for an address that isn't a
  // token on the queried chain — treat that as "not found here", not a failure.
  const r = json.result?.[address.toLowerCase()];
  return r && Object.keys(r).length > 0 ? r : null;
}

// Probe each EVM chain we support until one recognises the token; return its
// checks plus the chain we actually found it on. Chains are queried
// concurrently so a slow one can't stall the whole scan.
async function scanEvmAny(address: string): Promise<{ checks: ScanCheck[]; chainId: string }> {
  const evmChains = Object.values(CHAINS).filter((c) => c.goPlusChainId);
  const attempts = await Promise.allSettled(
    evmChains.map(async (c) => {
      const r = await goPlusLookup(c.goPlusChainId!, address);
      if (!r) throw new Error(`not found on ${c.id}`);
      return { chainId: c.id, raw: r };
    }),
  );
  const hit = attempts.find(
    (a): a is PromiseFulfilledResult<{ chainId: string; raw: Record<string, unknown> }> =>
      a.status === "fulfilled",
  );
  if (!hit) throw new Error("GoPlus: token not found on any supported EVM chain");
  return { checks: buildEvmChecks(hit.value.raw), chainId: hit.value.chainId };
}

function buildEvmChecks(r: Record<string, unknown>): ScanCheck[] {
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

const FAMILY_LABEL: Record<"solana" | "evm" | "ton", string> = {
  solana: "Solana",
  evm: "EVM",
  ton: "TON",
};

export async function scanToken(address: string): Promise<ScanResult> {
  const family = detectFamily(address);
  let checks: ScanCheck[];
  let chain: string | null = family === "solana" || family === "ton" ? family : null;
  let live = true;

  try {
    if (family === "solana") {
      checks = await scanSolana(address);
    } else if (family === "evm") {
      const res = await scanEvmAny(address);
      checks = res.checks;
      chain = res.chainId; // the specific EVM chain we actually found it on
    } else {
      // TON (no scanner yet) or unrecognised format
      throw new Error("no scanner coverage");
    }
  } catch {
    live = false;
    checks = [
      { label: "Live scan", value: "UNAVAILABLE", status: "warn" },
      { label: "Address format", value: family ? FAMILY_LABEL[family] : "UNRECOGNIZED", status: family ? "ok" : "warn" },
    ];
  }

  const { verdict, verdictText } = live
    ? verdictFor(checks)
    : { verdict: "warn" as const, verdictText: "⚠️ Scanner unavailable right now — DYOR before aping." };

  return { address, chain, checks, verdict, verdictText, live };
}
