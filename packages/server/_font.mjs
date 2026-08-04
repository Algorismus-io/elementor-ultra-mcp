import { chromium } from 'playwright';
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1440, height: 1000 } });
await pg.goto('http://localhost:8899/?page_id=685', { waitUntil: 'networkidle' }).catch(() => {});
const r = await pg.evaluate(() => {
  const h1 = [...document.querySelectorAll('*')].find((e) =>
    e.textContent.includes('financial stack for every'),
  );
  const root = document.querySelector('div');
  const p = [...document.querySelectorAll('p')].find((e) =>
    e.textContent.includes('Brex brings together'),
  );
  return {
    h1Font: h1 ? getComputedStyle(h1).fontFamily : '?',
    h1Weight: h1 ? getComputedStyle(h1).fontWeight : '?',
    h1Size: h1 ? getComputedStyle(h1).fontSize : '?',
    pFont: p ? getComputedStyle(p).fontFamily : '?',
  };
});
console.log(JSON.stringify(r));
await b.close();
