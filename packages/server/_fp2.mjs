import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1200, height: 600 } });
await pg.goto('http://localhost:8899/?page_id=702', { waitUntil: 'networkidle' }).catch(() => {});
const r = await pg.evaluate(() => {
  const find = (cls) => {
    const e = document.querySelector('.' + cls);
    if (!e) return { cls, missing: true };
    const cs = getComputedStyle(e);
    const rc = e.getBoundingClientRect();
    return {
      cls,
      bg: cs.backgroundColor,
      flex: cs.flex,
      w: Math.round(rc.width),
      h: Math.round(rc.height),
    };
  };
  return [find('e-ftA-s'), find('e-ftB-s'), find('e-ft0-s')];
});
console.log('computed:', JSON.stringify(r));
// dump CSS rules mentioning ftA
const css = await pg.evaluate(() => {
  let out = [];
  for (const sh of document.styleSheets) {
    try {
      for (const rule of sh.cssRules) {
        if (rule.cssText && /ftA|ftB|ftcardA|ftcardB/.test(rule.cssText))
          out.push(rule.cssText.slice(0, 200));
      }
    } catch (e) {}
  }
  return out;
});
console.log('CSS rules for ftA/ftB:');
css.forEach((c) => console.log('  ' + c));
await b.close();
