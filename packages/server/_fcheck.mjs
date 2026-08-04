import { chromium } from 'playwright';
const b=await chromium.launch();const pg=await b.newPage({viewport:{width:900,height:300}});
await pg.goto('http://localhost:8899/?page_id=768',{waitUntil:'networkidle'}).catch(()=>{});await pg.waitForTimeout(400);
const r=await pg.evaluate(()=>{const ds=[...document.querySelectorAll('div')].filter(e=>{const bg=getComputedStyle(e).backgroundColor;return bg==='rgb(255, 92, 53)'||bg==='rgb(59, 130, 246)';}).map(e=>({bg:getComputedStyle(e).backgroundColor,flex:getComputedStyle(e).flex,w:Math.round(e.getBoundingClientRect().width)}));return ds;});
console.log('RENDER',JSON.stringify(r));await b.close();
