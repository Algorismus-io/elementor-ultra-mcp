import { chromium } from 'playwright';
const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1000,height:400}});
await pg.goto('http://localhost:8899/?page_id=793',{waitUntil:'networkidle'}).catch(()=>{});await pg.waitForTimeout(400);
const cl='e-g0-s,e-g1-s,e-g2-s,e-g3-s,e-g4-s,e-g5-s,e-g6-s,e-g7-s'.split(',').slice(0,5);
const r=await pg.evaluate((cl)=>{const d=document.documentElement;const ws=cl.map(c=>{const e=document.querySelector('.'+c);return e?Math.round(e.getBoundingClientRect().width):null;});return{overflow:d.scrollWidth>d.clientWidth,scrollW:d.scrollWidth,cardWidths:ws};},cl);
console.log('GRID',JSON.stringify(r));await b.close();
