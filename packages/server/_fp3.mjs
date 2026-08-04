import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1000, height: 400 } });
await pg.goto('http://localhost:8899/?page_id=706', { waitUntil: 'networkidle' }).catch(() => {});
const r = await pg.evaluate(() => {
  const f = (c) => {
    const e = document.querySelector('.' + c);
    if (!e) return { c, missing: 1 };
    const s = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    return { c, bg: s.backgroundColor, flex: s.flex, w: Math.round(r.width) };
  };
  return [f('e-gA-s'), f('e-gB-s')];
});
console.log(JSON.stringify(r));
await b.close();
