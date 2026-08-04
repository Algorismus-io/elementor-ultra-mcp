import { chromium } from 'playwright';
const PID = process.argv[2];
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 390, height: 800 } });
await pg
  .goto('http://localhost:8899/?page_id=' + PID, { waitUntil: 'networkidle' })
  .catch(() => {});
await pg.waitForTimeout(500);
const r = await pg.evaluate(() => {
  const d = document.documentElement;
  const over = [...document.querySelectorAll('*')].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.right > 392;
  });
  return {
    scrollW: d.scrollWidth,
    overflow: d.scrollWidth > d.clientWidth,
    bleedCount: over.length,
    bleed: over
      .slice(0, 8)
      .map((e) => ({
        t: e.tagName.toLowerCase(),
        r: Math.round(e.getBoundingClientRect().right),
        w: Math.round(e.getBoundingClientRect().width),
        txt: (e.textContent || '').trim().slice(0, 18),
      })),
  };
});
console.log('MOBILE', JSON.stringify(r));
await b.close();
