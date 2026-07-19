# Bundled fonts

These fonts are embedded by `src/bannerRender.js` (via `@napi-rs/canvas`) to draw
the dynamic per-token banners and the static welcome/fallback banners. They are
redistributed here under their original open-source licenses.

| Font | Weights | Copyright | License |
|---|---|---|---|
| **Sora** | 400/500/600/700/800 | Copyright © 2020 The Sora Project Authors (https://github.com/SoraFonts/Sora) | SIL Open Font License 1.1 (see `OFL.txt`) |
| Liberation Sans | Bold/Regular | Copyright © Red Hat, Inc. | SIL Open Font License 1.1 (see `OFL.txt`) |
| DejaVu Sans Mono | Bold | DejaVu fonts (Bitstream Vera derivative) | Bitstream Vera / public-domain-style permissive |

Sora is the primary display/body typeface; the others are fallbacks used only when
Sora fails to load.

To refresh the static banner PNGs after editing the renderer:

```bash
node scripts/gen-banners.js
```
