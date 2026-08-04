import { chromium } from 'playwright';
const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1440,height:1000}});
await pg.goto('http://localhost:8899/?page_id=797',{waitUntil:'networkidle'}).catch(()=>{});await pg.waitForTimeout(700);
const r=await pg.evaluate(()=>{
  const d=document.documentElement;
  // find the product grid (display:grid container)
  const grids=[...document.querySelectorAll('*')].filter(e=>getComputedStyle(e).display==='grid');
  const info=grids.map(g=>{const cs=getComputedStyle(g);const kids=[...g.children].map(c=>Math.round(c.getBoundingClientRect().width));return{cols:cs.gridTemplateColumns,gap:cs.gap,kids};});
  return {overflow:d.scrollWidth>d.clientWidth,scrollW:d.scrollWidth,grids:info};
});
console.log(JSON.stringify(r,null,1).slice(0,900));await b.close();
