# Dexvra animated banner templates

Looping, on-brand promo banners for channel posts, listing alerts, and ad
slots. Each template is rendered in three formats from one source:

| File | Size | Use it for |
|---|---|---|
| `<kind>.gif`  | 760×398, ~0.8–1 MB | The admin **Banner Image** upload slot (accepts GIF, **≤ 3 MB**), inline chat |
| `<kind>.webm` | 1200×628, ~0.5 MB  | Telegram **channel / DM video posts** (crisp, small, loops) |
| `<kind>.png`  | 1200×628           | Static poster / fallback where animation isn't supported |

All three loop seamlessly (3 s cycle) and share the brand's gem mark,
mint→cyan gradient, dark premium background, dot grid and light sweep.

## Templates

- **`listing`** — "🚀 New Listing" — `$SYMBOL is now live on Dexvra`, with the
  token coin, chain, and tier badge. For listing alerts.
- **`trending`** — "🔥 Trending #N" — symbol, `▲ %` gain, MCAP→ATH, chain, plus
  an animated momentum equaliser. For the trending channel.
- **`ad`** — "📢 Featured Slot" — generic bookable banner with a CTA and a
  "your token here" placeholder. For ad / boost promos.

## Regenerate

```bash
npm run gen:banners            # all three
npm run gen:banners -- listing # one kind: listing | trending | ad
```

The script (`scripts/gen-banners.mjs`) auto-discovers the pre-installed
Chromium and Playwright's bundled ffmpeg. Override with `CHROMIUM_PATH` /
`FFMPEG_PATH` if needed (any ffmpeg with the `libvpx` VP8 encoder works).

## Customise for a real token

Pass `BANNER_DATA` (a JSON array) — no code edit needed. `out` is the output
basename; `grad` is the coin's 3-stop gradient; `emoji` is the coin glyph.

```bash
BANNER_DATA='[
  {"kind":"listing","symbol":"PEPE","chain":"Ethereum","chainColor":"#627EEA",
   "tier":"Diamond","emoji":"🐸","grad":["#B8FFD0","#3DF59F","#0B9E5E"],
   "out":"pepe-listing"},
  {"kind":"trending","symbol":"WIF","chain":"Solana","chainColor":"#14F195",
   "rank":1,"pct":"1240%","mcap":"$4.2M","ath":"$56M","emoji":"🐶",
   "grad":["#FFD9B8","#FF9D5C","#C25C00"],"out":"wif-trending"}
]' npm run gen:banners
```

### Fields per kind

- **listing**: `symbol`, `chain`, `chainColor`, `tier`, `emoji`, `grad`
- **trending**: `symbol`, `chain`, `chainColor`, `rank`, `pct`, `mcap`, `ath`, `emoji`, `grad`
- **ad**: `cta` (button label)
- **all**: `out` (output filename, without extension)

## Notes

- GIF is deliberately downscaled + palette-quantised to stay under the 3 MB
  upload cap. WebM keeps full resolution — prefer it wherever video is allowed
  (Telegram converts it to a looping animation).
- Telegram can't accept `.webm` from every client's *photo* picker — send it as
  a **video/animation**. For the web admin Banner Image slot, use the GIF.
