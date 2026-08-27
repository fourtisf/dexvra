"use client";

import { useMemo, useState } from "react";
import { logoCandidates, monogramOf, type LogoSource } from "@/lib/logo";

/** The token's logo, resolved by walking every known image source in order
 *  (see lib/logo.ts). A ticker monogram sits underneath and shows until an
 *  image actually paints — so the coin is filled while a logo is still in
 *  flight, and stays filled if every source 404s.
 *
 *  Renders inside a coin/pill whose size and background the parent owns; this
 *  component only decides what fills it. */
export function TokenLogo({
  token,
  alt,
  monogramChars,
}: {
  token: LogoSource & { symbol: string; name?: string };
  alt?: string;
  /** Trim the fallback monogram — small coins (ticker, search chips) can't
   *  fit three characters legibly. */
  monogramChars?: number;
}) {
  const { logoUrl, chain, address } = token;
  // Depend on the primitives, not the token object: the board re-fetches every
  // 30s and hands down a fresh object each time, which would otherwise reset a
  // token back to a URL we already know 404s and re-request it on every poll.
  const candidates = useMemo(
    () => logoCandidates({ logoUrl, chain, address }),
    [logoUrl, chain, address],
  );
  const [failed, setFailed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const src = candidates.find((c) => !failed.includes(c));

  return (
    <>
      {!loaded && (
        <span className="coin-mono" aria-hidden="true">
          {monogramOf(token.symbol, token.name, monogramChars)}
        </span>
      )}
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={src}
          src={src}
          alt={alt ?? `${token.symbol} logo`}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed((f) => (f.includes(src) ? f : [...f, src]))}
        />
      )}
    </>
  );
}
