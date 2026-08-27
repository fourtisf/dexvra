"use client";

import type { BoardToken } from "@/lib/types";
import { coinBg } from "@/lib/visual";
import type { CSSProperties } from "react";
import { ChainLogo } from "./ChainLogo";
import { TokenLogo } from "./TokenLogo";

/** Gradient coin (prototype look) filled with the token's real logo. Every
 *  listing has one: `TokenLogo` walks each known image source and ends on a
 *  ticker monogram, so the coin is never blank and never a stand-in emoji.
 *  The chain badge is the real chain logo. */
export function Coin({
  token,
  size,
  fontSize,
  withBadge = true,
}: {
  token: Pick<BoardToken, "logoUrl" | "chain" | "address" | "symbol" | "name" | "gradient">;
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
    <div className="coin" style={style} title={`${token.symbol} · ${token.name}`}>
      <TokenLogo token={token} />
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
