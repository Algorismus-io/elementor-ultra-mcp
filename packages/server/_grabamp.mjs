import { chromium } from 'playwright';
const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1440,height:900}});
let err='';
await pg.goto('http://amplusagency.com/',{waitUntil:'domcontentloaded',timeout:45000}).catch(e=>err=e.message);
await pg.waitForTimeout(3000);
// dismiss common cookie/consent
for(const sel of ['#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll','button:has-text("Accept")','button:has-text("Accept all")','[aria-label*="accept" i]','.cookie button']){const el=await pg.$(sel).catch(()=>null);if(el){await el.click().catch(()=>{});break;}}
await pg.evaluate(()=>{for(const s of ['[id*="ookie" i]','[class*="ookie" i]','[id*="consent" i]']){document.querySelectorAll(s).forEach(e=>{if(e.getBoundingClientRect().height>40)e.remove();});}});
await pg.waitForTimeout(800);
const info=await pg.evaluate(()=>{
  const vis=e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>2&&r.height>2&&s.visibility!=='hidden'&&s.display!=='none';};
  const heads=[...document.querySelectorAll('h1,h2,h3')].filter(vis).map(e=>e.tagName+': '+e.textContent.trim().replace(/\s+/g,' ')).filter(t=>t.length<110).slice(0,30);
  const nav=[...document.querySelectorAll('nav a, header a')].filter(vis).map(e=>e.textContent.trim()).filter(t=>t&&t.length<26).slice(0,16);
  const imgs=[...document.querySelectorAll('img')].map(i=>i.currentSrc||i.src).filter(s=>s&&s.startsWith('http')).filter((v,i,a)=>a.indexOf(v)===i).slice(0,12);
  return {title:document.title, bodyBg:getComputedStyle(document.body).backgroundColor, font:getComputedStyle(document.body).fontFamily, h:document.body.scrollHeight, nav:[...new Set(nav)], heads, imgs, err:''};
});
info.err=err;
console.log(JSON.stringify(info,null,1).slice(0,2800));
await pg.screenshot({path:'/tmp/amp_hero.png'});
await b.close();
