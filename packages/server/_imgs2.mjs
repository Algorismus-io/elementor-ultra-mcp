import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1440,height:900}});
await pg.goto('https://amundsen.com/',{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
await pg.waitForTimeout(3000);
for(const y of [2000,4000,6000]){await pg.evaluate(yy=>window.scrollTo(0,yy),y);await pg.waitForTimeout(1200);}
const urls=await pg.evaluate(()=>{const o=[];for(const i of document.querySelectorAll('img')){const s=i.currentSrc||i.src;if(s&&s.includes('amundsen-images')&&!o.includes(s))o.push(s);}return o;});
const norm=[...new Set(urls.map(u=>u.replace(/width=\d+/,'width=900').replace(/quality=\d+/,'quality=80')))];
writeFileSync('/tmp/amurls.txt',norm.slice(0,12).join('\n'));
console.log('wrote',Math.min(12,norm.length));
await b.close();
