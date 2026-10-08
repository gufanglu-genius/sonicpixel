const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC='/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
(async()=>{
  const b=await chromium.launch({executablePath:EXEC,args:['--no-sandbox']});
  const p=await b.newPage({viewport:{width:1440,height:1000}});
  await p.goto('http://127.0.0.1:8080/?fresh=1',{waitUntil:'networkidle'});
  await p.waitForTimeout(1200);
  // 拍之前先把真实文本打出来，避免“看着像对的”截图骗人
  console.log('dropzone 文本:', (await p.textContent('#dropzone p')).replace(/\s+/g,' ').trim());
  console.log('导入状态:', await p.textContent('#dropStatus'));
  await p.locator('#dropzone').screenshot({path:'/tmp/sonic-shots/midi/x-drop.png'});
  await p.click('#btnDemo');
  await p.waitForFunction(()=>document.querySelector('#mBpm')?.textContent.trim()!=='—',null,{timeout:240000});
  await p.waitForTimeout(700);
  console.log('状态条:', await p.textContent('#dropStatus'));
  console.log('mSr:', await p.textContent('#mSr'), '| 副标:', await p.evaluate(()=>document.querySelector('#mSr').closest('.metric').querySelector('.metric-sub').textContent));
  await p.locator('#metricGrid').screenshot({path:'/tmp/sonic-shots/midi/x-metrics.png'});
  console.log('ok');
  await b.close();
})().catch(e=>{console.error(e.message);process.exit(1)});
