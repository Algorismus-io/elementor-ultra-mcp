// Pixel-diff original test.html vs converted Elementor page. Usage: node _odiff.mjs
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { writeFileSync, readFileSync } from 'node:fs';

const W = 1440;
const ORIG_URL = 'file:///Users/shahmir/projects/elementor-mcp/test.html';
const CONV_URL = 'http://localhost:8899/wpos-ai-landing-v2/';

const browser = await chromium.launch();

async function shoot(url, path, reduced) {
  const pg = await browser.newPage({ viewport: { width: W, height: 900 } });
  if (reduced) await pg.emulateMedia({ reducedMotion: 'reduce' });
  await pg.goto(url, { waitUntil: 'networkidle' });
  // force-eager lazy images + decode (matters for the converted page)
  await pg.evaluate(async () => {
    document.querySelectorAll('img[loading="lazy"]').forEach((i) => (i.loading = 'eager'));
    for (let y = 0; y < document.body.scrollHeight; y += 800) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 50));
    }
    window.scrollTo(0, 0);
    await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
    await document.fonts.ready;
  });
  await pg.waitForTimeout(400);
  // NOT fullPage: Playwright's fullPage capture expands the canvas to scrollWidth (1600 for the
  // source hero glow's clipped 160px overhang — the body declares `overflow-x:hidden`) and the
  // layout RE-CENTERS in the wider canvas, shifting every pixel +80px vs the converted page's
  // 1440 — the diff then measures the harness artifact, not the conversion. A viewport-tall
  // normal capture keeps both sides at the real 1440 (no vh units in either page).
  const h = await pg.evaluate(() => document.documentElement.scrollHeight);
  await pg.setViewportSize({ width: W, height: h });
  // The resize brings EVERY section into view at once — the converted page's scrollIn entrance
  // interactions (contract 16 tier 2) all fire together; capture only after they settle or the
  // shot catches the whole page mid-fade (band 7 measured 95.5% from a half-opacity wash).
  await pg.waitForTimeout(1500);
  await pg.screenshot({ path });
  await pg.close();
  return h;
}

const h1 = await shoot(ORIG_URL, '/tmp/odiff-original.png', true);
const h2 = await shoot(CONV_URL, '/tmp/odiff-converted.png', false);
await browser.close();
console.log(`heights: original=${h1}px converted=${h2}px (delta ${h2 - h1}px)`);

const a = PNG.sync.read(readFileSync('/tmp/odiff-original.png'));
const b = PNG.sync.read(readFileSync('/tmp/odiff-converted.png'));
const width = Math.min(a.width, b.width);
const height = Math.min(a.height, b.height);

// crop both to common region
function crop(img) {
  const out = new PNG({ width, height });
  PNG.bitblt(img, out, 0, 0, width, height, 0, 0);
  return out;
}
const ca = crop(a);
const cb = crop(b);
const diff = new PNG({ width, height });
const mismatched = pixelmatch(ca.data, cb.data, diff.data, width, height, {
  threshold: 0.15,
  diffColor: [255, 0, 90],
  alpha: 0.4,
});
writeFileSync('/tmp/odiff-v2-diff.png', PNG.sync.write(diff));
const pct = ((mismatched / (width * height)) * 100).toFixed(2);
console.log(`MISMATCH: ${mismatched.toLocaleString()} px of ${(width * height).toLocaleString()} = ${pct}%`);

// per-band attribution: 14 horizontal bands
const bands = 14;
const bandH = Math.floor(height / bands);
for (let i = 0; i < bands; i++) {
  let count = 0;
  for (let y = i * bandH; y < (i + 1) * bandH; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (diff.data[idx] === 255 && diff.data[idx + 2] === 90) count++;
    }
  }
  const bp = ((count / (bandH * width)) * 100).toFixed(1);
  const bar = '#'.repeat(Math.round(bp / 2.5));
  console.log(`band ${String(i).padStart(2)} (y ${i * bandH}-${(i + 1) * bandH}): ${String(bp).padStart(5)}% ${bar}`);
}