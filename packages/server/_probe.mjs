import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1440, height: 1000 } });
await pg.goto('http://localhost:8899/?page_id=677', { waitUntil: 'networkidle' }).catch(() => {});
const r = await pg.evaluate(() => {
  const out = [];
  // find the stats row: a flex container whose children contain "$30B+"
  const els = [...document.querySelectorAll('*')];
  const stat = els.find((e) => e.textContent.trim() === '$30B+');
  if (stat) {
    let card = stat.closest('div'); // the stat card
    // climb to the card (has border-radius)
    let c = stat;
    for (let i = 0; i < 4; i++) {
      c = c.parentElement;
    }
    const card2 = stat.parentElement;
    const rowEl = card2.parentElement;
    const cs = getComputedStyle(card2),
      rs = getComputedStyle(rowEl);
    out.push({
      node: 'statCard',
      flexGrow: cs.flexGrow,
      flexBasis: cs.flexBasis,
      width: cs.width,
      display: cs.display,
    });
    out.push({
      node: 'statRow',
      display: rs.display,
      flexDirection: rs.flexDirection,
      flexWrap: rs.flexWrap,
      width: rs.width,
    });
  }
  return out;
});
console.log(JSON.stringify(r, null, 2));
await b.close();
