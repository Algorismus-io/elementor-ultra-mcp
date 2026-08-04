import { chromium } from 'playwright';
const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1440,height:1000}});
await pg.goto('http://localhost:8899/?page_id=788',{waitUntil:'networkidle'}).catch(()=>{});await pg.waitForTimeout(800);
const r=await pg.evaluate(()=>[...document.querySelectorAll('img')].map(i=>({w:Math.round(i.getBoundingClientRect().width),h:Math.round(i.getBoundingClientRect().height),nat:i.naturalWidth,broken:i.naturalWidth===0,src:i.currentSrc.slice(-40)})));
console.log('images:',r.length,'broken:',r.filter(x=>x.broken).length);
r.forEach((x,i)=>console.log(i,x.broken?'BROKEN':'ok',x.w+'x'+x.h,'nat'+x.nat,x.src));
await b.close();
