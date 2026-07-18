"use client";

import type { BoardToken } from "@/lib/types";
import { coinBg } from "@/lib/visual";
import type { CSSProperties } from "react";
import { ChainLogo } from "./ChainLogo";

/** Emoji-gradient coin (prototype look) that upgrades to the real logo when
 *  the provider supplies one. The chain badge is the real chain logo. */
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
  const badgeSize = size ? Math.max(13, Math.round(size * 0.42)) : 16;
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
  if (!withBadge) return inner;
  return (
    <span className="coin-wrap">
      {inner}
      <span className="cbadge cbadge-logo">
        <ChainLogo chain={token.chain} size={badgeSize} />
      </span>
    </span>
  );
}
