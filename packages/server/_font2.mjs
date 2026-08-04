import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1440, height: 1000 } });
await pg.goto('http://localhost:8899/?page_id=685', { waitUntil: 'networkidle' }).catch(() => {});
const r = await pg.evaluate(() => {
  const out = [];
  for (const h of document.querySelectorAll('h1,h2,h3')) {
    const cs = getComputedStyle(h);
    out.push({
      tag: h.tagName.toLowerCase(),
      txt: h.textContent.trim().slice(0, 28),
      size: cs.fontSize,
      weight: cs.fontWeight,
      font: cs.fontFamily.split(',')[0],
      color: cs.color,
    });
  }
  return out.slice(0, 10);
});
console.log(JSON.stringify(r, null, 1));
await b.close();
