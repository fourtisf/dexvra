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
  const logoSize = size ? Math.max(14, Math.round(size * 0.4)) : 15;
  const ring = logoSize + 4; // badge = logo + a thin card-colored ring, so nothing clips
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
      <span className="cbadge cbadge-logo" style={{ width: ring, height: ring }}>
        <ChainLogo chain={token.chain} size={logoSize} />
      </span>
    </span>
  );
}
