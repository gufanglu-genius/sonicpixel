const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC='/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
(async()=>{
  const b=await chromium.launch({executablePath:EXEC,args:['--no-sandbox']});
  const p=await b.newPage({viewport:{width:1440,height:1000}});
  await p.goto('http://127.0.0.1:8080/?fresh=1',{waitUntil:'networkidle'});
  await p.waitForTimeout(1000);
  const r=await p.evaluate(()=>{
    const dz=document.querySelector('#dropzone'), para=dz.querySelector('p');
    const dzr=dz.getBoundingClientRect(), pr=para.getBoundingClientRect();
    const btns=[...dz.querySelectorAll('button')].map(b=>({t:b.textContent.trim(),vis:b.getBoundingClientRect().width>0}));
    // 文案有没有把按钮顶出卡片 / 卡片有没有被撑出横向滚动
    const overflow = para.scrollWidth > para.clientWidth + 1;
    return {
      dzH:Math.round(dzr.height), paraH:Math.round(pr.height),
      paraBottom:Math.round(pr.bottom), dzBottom:Math.round(dzr.bottom),
      btnTop:Math.round(dz.querySelector('.dropzone-actions').getBoundingClientRect().top),
      btns, overflow,
      docScrollW:document.documentElement.scrollWidth, winW:innerWidth,
      copy:para.textContent.replace(/\s+/g,' ').trim(),
    };
  });
  console.log(JSON.stringify(r,null,1));
  const ok = r.paraBottom <= r.btnTop && !r.overflow && r.docScrollW <= r.winW && r.btns.every(x=>x.vis);
  console.log(ok?'版式 OK':'版式有问题');
  await b.close(); process.exit(ok?0:1);
})().catch(e=>{console.error(e.message);process.exit(1)});
