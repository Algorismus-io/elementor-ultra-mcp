// Scroll-capture N viewport screenshots. Usage: node _shots.mjs <url> <prefix> [width] [vh]
import { chromium } from 'playwright';
const [, , url, prefix, wArg, vhArg] = process.argv;
const width = parseInt(wArg || '1440', 10),
  vh = parseInt(vhArg || '1250', 10);
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width, height: vh }, deviceScaleFactor: 1 });
await pg.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await pg.waitForTimeout(700);
const total = await pg.evaluate(() => document.body.scrollHeight);
const n = Math.ceil(total / vh);
for (let i = 0; i < n; i++) {
  await pg.evaluate((y) => window.scrollTo(0, y), i * vh);
  await pg.waitForTimeout(250);
  await pg.screenshot({ path: `${prefix}-${i}.png` });
}
await b.close();
console.log('captured', n, 'shots, total height', total);
