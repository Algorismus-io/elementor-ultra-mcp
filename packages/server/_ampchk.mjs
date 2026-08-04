import { chromium } from 'playwright';
const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1440,height:1000}});
await pg.goto('http://localhost:8899/?page_id=810',{waitUntil:'networkidle'}).catch(()=>{});await pg.waitForTimeout(800);
const r=await pg.evaluate(()=>{
  const grids=[...document.querySelectorAll('*')].filter(e=>getComputedStyle(e).display==='grid').map(g=>({cols:getComputedStyle(g).gridTemplateColumns.split(' ').length,gap:getComputedStyle(g).gap}));
  const imgs=[...document.querySelectorAll('img')];
  return {gridCount:grids.length, grids:grids.slice(0,6), imgsTotal:imgs.length, imgsBroken:imgs.filter(i=>i.naturalWidth===0).length};
});
console.log(JSON.stringify(r));await b.close();
