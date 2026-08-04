import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1000, height: 400 } });
await pg.goto('http://localhost:8899/?page_id=', { waitUntil: 'networkidle' }).catch(() => {});
await pg.waitForTimeout(400);
const r = await pg.evaluate(() =>
  ['e-fda-s', 'e-fdb-s', 'e-fdc-s'].map((c) => {
    const e = document.querySelector('.' + c);
    if (!e) return { c, missing: 1 };
    const s = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    return {
      c,
      flexGrow: s.flexGrow,
      flexBasis: s.flexBasis,
      bg: s.backgroundColor,
      w: Math.round(r.width),
    };
  }),
);
console.log('FLEX', JSON.stringify(r));
await b.close();
