# Bundled fonts

These fonts are embedded by `src/bannerRender.js` (via `@napi-rs/canvas`) to draw
the dynamic per-token banners and the static welcome/fallback banners. They are
redistributed here under their original open-source licenses.

| Font | Weights | Copyright | License |
|---|---|---|---|
| **Space Grotesk** | 500/600/700 | Copyright © 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk) | SIL Open Font License 1.1 (see `OFL.txt`) |
| **JetBrains Mono** | 600/700/800 | Copyright © 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) | SIL Open Font License 1.1 (see `OFL.txt`) |
| **Sora** | 400/500/600/700/800 | Copyright © 2020 The Sora Project Authors (https://github.com/SoraFonts/Sora) | SIL Open Font License 1.1 (see `OFL.txt`) |
| Liberation Sans | Bold/Regular | Copyright © Red Hat, Inc. | SIL Open Font License 1.1 (see `OFL.txt`) |
| DejaVu Sans Mono | Bold | DejaVu fonts (Bitstream Vera derivative) | Bitstream Vera / public-domain-style permissive |

**Space Grotesk + JetBrains Mono are the SITE's typefaces** (`src/app/globals.css`
sets `--fd` and `--fm` to them). Anything meant to look like dexvra.io — the
Top-Gainers banners — uses those two: Space Grotesk for display text, JetBrains
Mono for every stat, ticker and wide-tracked micro-label. Artwork that ships a
different typeface reads as a third-party graphic no matter how well drawn it is.

Sora is the older display face used by the per-token listing/trending/rank-up
cards (`bannerRender.js`); Liberation Sans and DejaVu Sans Mono are fallbacks
used only when a preferred face fails to load.

Static per-weight TTFs, fetched from Google Fonts:

```bash
curl -sS -A "Mozilla/5.0" \
  "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@600;700;800"
# then download each ttf URL to <Family>-<weight>.ttf
```

To refresh the static banner PNGs after editing the renderer:

```bash
node scripts/gen-banners.js
```
