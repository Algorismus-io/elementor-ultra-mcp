import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1200, height: 600 } });
await pg.goto('http://localhost:8899/?page_id=702', { waitUntil: 'networkidle' }).catch(() => {});
const r = await pg.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('div')) {
    const cs = getComputedStyle(el);
    const rc = el.getBoundingClientRect();
    const bg = cs.backgroundColor;
    if (bg === 'rgb(255, 92, 53)' || bg === 'rgb(27, 27, 32)') {
      out.push({
        bg,
        display: cs.display,
        flexGrow: cs.flexGrow,
        flexShrink: cs.flexShrink,
        flexBasis: cs.flexBasis,
        flex: cs.flex,
        w: Math.round(rc.width),
        h: Math.round(rc.height),
      });
    }
    if (cs.display === 'flex' && el.querySelectorAll(':scope>div').length >= 2) {
      out.push({
        ROW: true,
        display: cs.display,
        flexDir: cs.flexDirection,
        w: Math.round(rc.width),
        children: el.querySelectorAll(':scope>div').length,
      });
    }
  }
  return out;
});
console.log(JSON.stringify(r, null, 1));
await b.close();
