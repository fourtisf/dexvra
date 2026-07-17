"use client";

import { CHAINS } from "@/config/chains";
import type { BoardToken } from "@/lib/types";
import { coinBg } from "@/lib/visual";
import type { CSSProperties } from "react";

/** Emoji-gradient coin (prototype look) that upgrades to the real logo when
 *  the provider supplies one. Optional chain badge dot. */
export function Coin({
  token,
  size,
  fontSize,
  withBadge = true,
}: {
  token: Pick<BoardToken, "emoji" | "gradient" | "logoUrl" | "chain" | "symbol">;
  size?: number;
  fontSize?: number;
  withBadge?: boolean;
}) {
  const style: CSSProperties = { background: coinBg(token.gradient) };
  if (size) {
    style.width = size;
    style.height = size;
  }
  if (fontSize) style.fontSize = fontSize;
  const chain = CHAINS[token.chain];
  const inner = (
    <div className="coin" style={style}>
      {token.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={token.logoUrl} alt="" loading="lazy" />
      ) : (
        token.emoji
      )}
    </div>
  );
  if (!withBadge || !chain) return inner;
  return (
    <span className="coin-wrap">
      {inner}
      <span className="cbadge" style={{ background: chain.color }} />
    </span>
  );
}
