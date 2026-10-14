const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC='/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
(async()=>{
  const b=await chromium.launch({executablePath:EXEC,args:['--no-sandbox']});
  const p=await b.newPage({viewport:{width:1440,height:1000}});
  await p.goto('http://127.0.0.1:8080/?fresh=1',{waitUntil:'networkidle'});
  await p.waitForTimeout(900);
  await p.locator('#dropzone').screenshot({path:'/tmp/sonic-shots/midi/imp-copy.png'});
  await p.click('#btnDemo');
  await p.waitForFunction(()=>document.querySelector('#mBpm')?.textContent.trim()!=='—',null,{timeout:240000});
  await p.waitForTimeout(700);
  await p.locator('#metricGrid').screenshot({path:'/tmp/sonic-shots/midi/metrics.png'});
  console.log('ok');
  await b.close();
})().catch(e=>{console.error(e.message);process.exit(1)});
