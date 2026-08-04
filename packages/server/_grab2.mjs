import { chromium } from 'playwright';
const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1440,height:900}});
await pg.goto('https://amundsen.com/',{waitUntil:'domcontentloaded',timeout:45000}).catch(e=>console.error('goto',e.message));
await pg.waitForTimeout(2500);
// dismiss cookiebot
for(const sel of ['#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll','#CybotCookiebotDialogBodyButtonAccept','button:has-text("Accept all")']){
  const el=await pg.$(sel); if(el){await el.click().catch(()=>{}); break;}
}
await pg.evaluate(()=>{const c=document.getElementById('CybotCookiebotDialog');if(c)c.remove();const o=document.querySelector('[id*="Cookiebot"]');if(o)o.remove();});
await pg.waitForTimeout(1500);
const info=await pg.evaluate(()=>{
  const vis=e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
  const heads=[...document.querySelectorAll('h1,h2,h3')].filter(vis).map(e=>e.tagName+': '+e.textContent.trim()).filter(t=>t.length<100).slice(0,25);
  const nav=[...document.querySelectorAll('nav a, header a')].filter(vis).map(e=>e.textContent.trim()).filter(t=>t&&t.length<30).slice(0,15);
  const bodyBg=getComputedStyle(document.body).backgroundColor;
  const font=getComputedStyle(document.body).fontFamily;
  return {title:document.title, bodyBg, font, nav:[...new Set(nav)], heads};
});
console.log(JSON.stringify(info,null,1));
await pg.screenshot({path:'/tmp/amundsen_hero.png'}); // viewport (hero)
await b.close();
