import { chromium } from 'playwright';
const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1440,height:1000}});
await pg.goto('https://amundsen.com/',{waitUntil:'networkidle',timeout:45000}).catch(e=>console.error('goto',e.message));
await pg.waitForTimeout(1500);
const info=await pg.evaluate(()=>{
  const txt=[...document.querySelectorAll('h1,h2,h3,p,a,button,li')].map(e=>e.textContent.trim()).filter(t=>t&&t.length<120).slice(0,80);
  const imgs=[...document.querySelectorAll('img')].map(i=>i.src).filter(s=>s&&s.startsWith('http')).slice(0,20);
  const h=document.body.scrollHeight;
  return {title:document.title, h, headings:[...document.querySelectorAll('h1,h2')].map(e=>e.textContent.trim()).filter(Boolean).slice(0,30), txt:[...new Set(txt)].slice(0,60), imgs};
});
console.log(JSON.stringify(info,null,1).slice(0,3500));
await b.close();
