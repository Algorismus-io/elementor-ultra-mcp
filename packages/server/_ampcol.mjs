import { chromium } from 'playwright';
const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1440,height:900}});
await pg.goto('http://amplusagency.com/',{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
await pg.waitForTimeout(2500);
const r=await pg.evaluate(()=>{
  const h1=document.querySelector('h1');
  const heroSec=h1?h1.closest('section,div'):null;
  const secs=[...document.querySelectorAll('section')].slice(0,8).map(s=>{const cs=getComputedStyle(s);return {bg:cs.backgroundColor,bgImg:cs.backgroundImage.slice(0,60)};});
  return {font:getComputedStyle(document.body).fontFamily, h1font:h1?getComputedStyle(h1).fontFamily:'', h1size:h1?getComputedStyle(h1).fontSize:'', heroBg:heroSec?getComputedStyle(heroSec).backgroundImage.slice(0,90):'', secs};
});
console.log(JSON.stringify(r,null,1).slice(0,1400));
await b.close();
