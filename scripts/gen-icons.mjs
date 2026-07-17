// Generates the PWA PNG icons (192/512) without any image dependency:
// raw RGBA pixels → zlib deflate → hand-assembled PNG chunks. Draws the
// brand gradient in a rounded square with a blocky placeholder "F" glyph
// (real logo is still TBD per the handoff).
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../public/icons");

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const lerp = (a, b, t) => a + (b - a) * t;
const MINT = [0x3d, 0xf5, 0x9f];
const CYAN = [0x22, 0xd3, 0xee];
const INK = [0x03, 0x15, 0x0b];

// Blocky "F" on a 12x12 grid, drawn over the middle ~56% of the icon.
const F_ROWS = [
  "111111111",
  "111111111",
  "110000000",
  "110000000",
  "111111100",
  "111111100",
  "110000000",
  "110000000",
  "110000000",
  "110000000",
];

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.234; // ≈ rounded-square ratio of the brand mark
  const glyphX = size * 0.30, glyphY = size * 0.22;
  const glyphW = size * 0.42, glyphH = size * 0.56;
  const cellW = glyphW / F_ROWS[0].length, cellH = glyphH / F_ROWS.length;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // rounded-corner mask
      const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
      if (dx * dx + dy * dy > radius * radius) {
        rgba[i + 3] = 0;
        continue;
      }
      const t = (x + y) / (2 * size);
      let [r, g, b] = [
        lerp(MINT[0], CYAN[0], t),
        lerp(MINT[1], CYAN[1], t),
        lerp(MINT[2], CYAN[2], t),
      ];
      const gx = Math.floor((x - glyphX) / cellW);
      const gy = Math.floor((y - glyphY) / cellH);
      if (gy >= 0 && gy < F_ROWS.length && gx >= 0 && gx < F_ROWS[0].length && F_ROWS[gy][gx] === "1") {
        [r, g, b] = INK;
      }
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return png(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(join(OUT_DIR, `icon-${size}.png`), drawIcon(size));
  console.log(`icon-${size}.png written`);
}
