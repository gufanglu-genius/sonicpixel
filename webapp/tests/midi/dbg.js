const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC='/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
(async()=>{
  const b=await chromium.launch({executablePath:EXEC,args:['--no-sandbox']});
  const p=await b.newPage({viewport:{width:1440,height:1000}});
  p.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  p.on('console',m=>{if(m.type()==='error')console.log('CONSOLE:',m.text())});
  await p.goto('http://127.0.0.1:8080/',{waitUntil:'networkidle'});
  await p.waitForTimeout(8000);
  const s=await p.evaluate(()=>({
    save:(document.querySelector('#saveStatus')||{}).textContent,
    drop:(document.querySelector('#dropStatus')||{}).textContent,
    bpm:(document.querySelector('#mBpm')||{}).textContent,
    status:(document.querySelector('#heroStatusText')||{}).textContent,
    refineHidden:document.querySelector('#refineBody')?.hasAttribute('hidden'),
    chips:document.querySelectorAll('#sourceKind .chip').length,
    clearHidden:!document.querySelector('#btnClearWs').hasAttribute('hidden'),
  }));
  console.log(JSON.stringify(s,null,1));
  await b.close();
})().catch(e=>{console.error(e.message);process.exit(1)});
