import { chromium } from 'playwright';
const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1000,height:400}});
await pg.goto('http://localhost:8899/?page_id=764',{waitUntil:'networkidle'}).catch(()=>{});await pg.waitForTimeout(500);
const cls='e-fx0-s,e-fx1-s,e-fx2-s'.split(',');
const r=await pg.evaluate((cls)=>cls.map(c=>{const e=document.querySelector('.'+c);if(!e)return{c,missing:1};const s=getComputedStyle(e);const r=e.getBoundingClientRect();return{c,flexGrow:s.flexGrow,flexBasis:s.flexBasis,bg:s.backgroundColor,w:Math.round(r.width)};}),cls);
console.log('FLEXCHECK',JSON.stringify(r));await b.close();
