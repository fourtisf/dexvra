import type { FearGreed } from "@/lib/types";

// alternative.me crypto Fear & Greed index — free, no key.
export async function fetchFearGreed(): Promise<FearGreed> {
  const res = await fetch("https://api.alternative.me/fng/?limit=1", {
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`alternative.me ${res.status}`);
  const json = (await res.json()) as {
    data: { value: string; value_classification: string; timestamp: string }[];
  };
  const d = json.data?.[0];
  if (!d) throw new Error("alternative.me empty payload");
  return {
    value: Number(d.value),
    label: d.value_classification,
    updatedMinutesAgo: Math.max(
      0,
      Math.round((Date.now() / 1000 - Number(d.timestamp)) / 60),
    ),
    source: "live",
  };
}

export const SEED_FEAR_GREED: FearGreed = {
  value: 63,
  label: "Greed",
  updatedMinutesAgo: 6,
  source: "seed",
};
