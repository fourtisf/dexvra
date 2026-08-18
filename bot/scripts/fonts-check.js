#!/usr/bin/env node
'use strict';
/*
 * fonts:check — which scripts THIS box can actually draw on a banner.
 *
 * A token listed as 牛来 ($牛来) went to 12,607 subscribers as "$???", twice:
 * once on the listing card and again on the pump alert. Nothing failed and
 * nothing logged, because a missing glyph does not throw — it draws a box or a
 * question mark and ships.
 *
 * Whether a glyph can be drawn is a property of the FONTS ON THIS MACHINE, not
 * of the code, exactly like `raid:check` and `launchpads:check` before it. So it
 * has to be measured on the box, and this is the command that does it.
 *
 * It also writes a real PNG, because a width comparison proves a font was
 * matched and a human eye is what confirms the result is legible.
 */
const path = require('node:path');
const fs = require('node:fs');
const kit = require('../src/helpers/canvasKit');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';

const cov = kit.coverage();
if (!cov.available) {
  console.log(`${R}✗ @napi-rs/canvas is not loadable on this box — every banner is falling back to a static image.${X}`);
  console.log('  Nothing below can be measured until that is fixed.');
  process.exit(1);
}

console.log('\nFont coverage for banner rendering\n');
// The chain, in the order canvas walks it. A script that shows ✗ below is either
// a face this list never found or a face that is present and lacks the glyph —
// and only seeing the resolved paths tells the two apart.
if (cov.faces && cov.faces.length) {
  console.log(`  ${D}fallback chain, in order:${X}`);
  for (const f of cov.faces) console.log(`    ${G}${f.family.replace('DexCover ', '').padEnd(7)}${X} ${D}${f.path}${X}`);
} else {
  console.log(`  ${R}no coverage faces registered at all — every non-Latin name draws boxes${X}`);
}
console.log('');

const LABEL = {
  latin: 'Latin        (Ab)', greek: 'Greek        (Ωπ)', cyrillic: 'Cyrillic     (Дж)',
  chinese: 'Chinese      (牛来)', japanese: 'Japanese     (あア)', korean: 'Korean       (한글)',
  thai: 'Thai         (ไทย)', arabic: 'Arabic       (عربي)', emoji: 'Emoji        (🚀)',
};
let missing = 0;
for (const [k, ok] of Object.entries(cov.scripts)) {
  if (!ok) missing++;
  console.log(`  ${ok ? G + '✓' : R + '✗'}${X} ${LABEL[k] || k}`);
}

// A PICTURE, not just a table. The widths above prove a font was matched; only
// looking at it proves the result is readable at banner size.
try {
  const CV = kit.canvasLib();
  const c = CV.createCanvas(900, 420), ctx = c.getContext('2d');
  ctx.fillStyle = '#0B1620'; ctx.fillRect(0, 0, 900, 420);
  ctx.fillStyle = '#F4F9F8';
  let y = 60;
  for (const [k, sample] of [
    ['brand face', 'Dexvra 0123'], ['chinese', '牛来 ($牛来)'], ['japanese', 'あア 日本語'],
    ['korean', '한글 토큰'], ['cyrillic', 'Дж Токен'], ['thai', 'ไทย'], ['arabic', 'عربي'], ['emoji', '🚀 📈 💎'],
  ]) {
    ctx.font = `28px ${kit.F.r}`;
    ctx.fillStyle = '#7E9AA6'; ctx.fillText(k, 40, y);
    ctx.font = `44px ${kit.F.x}`;
    ctx.fillStyle = '#F4F9F8'; ctx.fillText(sample, 260, y);
    y += 46;
  }
  const out = path.join(__dirname, '..', 'fonts-check.png');
  fs.writeFileSync(out, c.toBuffer('image/png'));
  console.log(`\n  ${D}sample written to${X} ${out}`);
} catch (e) {
  console.log(`\n  ${Y}could not write the sample image: ${e.message}${X}`);
}

// THE PACKAGE, not a count.
//
// This printed "1 script(s) above are still uncovered" on the production box,
// which is a diagnostic and not an instruction — and the script it meant was
// emoji, whose font lives in fonts-noto-color-emoji, a package that NEITHER
// fonts-noto-cjk NOR fonts-noto-core pulls in. The install line given from
// memory left it out, so the operator did everything asked and still had a gap.
// The mapping is in canvasKit now, so the answer is computed rather than recalled.
const gaps = Object.entries(cov.scripts).filter(([, ok]) => !ok).map(([k]) => k);
if (!gaps.length) {
  console.log(`\n${G}Every script sampled here renders.${X}`);
} else {
  const pkgs = kit.packagesFor(gaps);
  // Say what the USER loses, not which file is absent — the rule the upstream
  // probes already follow.
  console.log(`\n${R}Names using ${gaps.join(', ')} draw boxes on every banner they appear on.${X}`);
  // A MISSING BUNDLED FACE IS A DIFFERENT PROBLEM, and it gets a different
  // sentence. Every text face ships in bot/assets/fonts and arrives with the
  // deploy, so one that is absent means the checkout is incomplete — apt would
  // paper over it and leave the repo still wrong.
  const lost = (kit.BUNDLED || []).filter((f) => !fs.existsSync(path.join(kit.FONTS_DIR, f)));
  if (lost.length) {
    console.log(`\n${Y}bot/assets/fonts is missing ${lost.join(', ')} — these are git-tracked and ship with the deploy.${X}`);
    console.log(`  ${G}cd /opt/dexvra && git pull origin main${X}   ${D}(this checkout is incomplete)${X}`);
  }
  if (pkgs.length) {
    console.log('\nFix it on this box:');
    console.log(`  ${G}apt-get install -y ${pkgs.join(' ')}${X}`);
    console.log(`  ${D}then: cd bot && pm2 restart ecosystem.config.js --update-env && npm run fonts:check${X}`);
  }
  console.log(`\n  ${D}…or drop the face into bot/assets/fonts/ — that path is tried first, so it always wins.${X}`);
}
console.log('');
