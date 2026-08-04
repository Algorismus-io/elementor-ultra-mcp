import { chromium } from 'playwright';
const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1440,height:900}});
await pg.goto('https://amundsen.com/',{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
await pg.waitForTimeout(3000);
await pg.evaluate(()=>window.scrollTo(0,2500)); await pg.waitForTimeout(1500);
await pg.evaluate(()=>window.scrollTo(0,5000)); await pg.waitForTimeout(1500);
const urls=await pg.evaluate(()=>{
  const out=[];
  for(const img of document.querySelectorAll('img')){
    const s=img.currentSrc||img.src;
    if(s&&s.includes('amundsen-images')&&!out.includes(s))out.push(s);
  }
  return out;
});
// normalize width to 800
const norm=urls.map(u=>u.replace(/width=\d+/,'width=800').replace(/quality=\d+/,'quality=80')).filter((v,i,a)=>a.indexOf(v)===i);
console.log('count',norm.length);
norm.slice(0,14).forEach((u,i)=>console.log(i+'\t'+u));
await b.close();
