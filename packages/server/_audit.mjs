import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:8899/?page_id=685';
const VW = 1440;
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: VW, height: 1000 } });
await pg.goto(url, { waitUntil: 'networkidle' }).catch(() => {});
await pg.waitForTimeout(600);
const r = await pg.evaluate((VW) => {
  const doc = document.documentElement;
  const overflow = {
    scrollW: doc.scrollWidth,
    clientW: doc.clientWidth,
    horizOverflow: doc.scrollWidth > doc.clientWidth,
  };
  // elements bleeding past viewport
  const bleed = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > VW + 1 || r.left < -1)) {
      bleed.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 30),
        left: Math.round(r.left),
        right: Math.round(r.right),
        w: Math.round(r.width),
      });
    }
  }
  // top-level sections (children of the root flex)
  const root =
    document.querySelector('.elementor')?.firstElementChild?.firstElementChild ||
    document.body.querySelector('[data-element_type]');
  // find the page root: the big flex column
  let pageRoot = null;
  let best = 0;
  for (const el of document.querySelectorAll('div')) {
    const r = el.getBoundingClientRect();
    if (r.width > 1000 && el.children.length >= 8 && r.height > best) {
      best = r.height;
      pageRoot = el;
    }
  }
  const sections = [];
  if (pageRoot) {
    [...pageRoot.children].forEach((sec, i) => {
      const sr = sec.getBoundingClientRect();
      // inner content = first child (wrap)
      const inner = sec.querySelector(':scope > *');
      const ir = inner ? inner.getBoundingClientRect() : sr;
      const cs = getComputedStyle(sec);
      sections.push({
        i,
        tag: sec.tagName.toLowerCase(),
        secW: Math.round(sr.width),
        secPad: cs.padding,
        innerLeft: Math.round(ir.left),
        innerRight: Math.round(ir.right),
        innerW: Math.round(ir.width),
      });
    });
  }
  // flex container default padding sample
  const flexPads = {};
  let cnt = 0;
  for (const el of document.querySelectorAll('div')) {
    if (cnt >= 6) break;
    const cs = getComputedStyle(el);
    if (cs.display === 'flex' && cs.padding !== '0px') {
      flexPads['sample' + cnt] = {
        cls: (el.className || '').toString().slice(0, 24),
        padding: cs.padding,
      };
      cnt++;
    }
  }
  return {
    overflow,
    bleedCount: bleed.length,
    bleed: bleed.slice(0, 12),
    sectionCount: sections.length,
    sections,
    flexPads,
  };
}, VW);
console.log(JSON.stringify(r, null, 2));
await b.close();
