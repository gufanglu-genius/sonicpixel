const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC='/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
(async()=>{
  const b=await chromium.launch({executablePath:EXEC,args:['--no-sandbox']});
  const p=await b.newPage({viewport:{width:1440,height:1000}});
  await p.goto('http://127.0.0.1:8080/?fresh=1',{waitUntil:'networkidle'});
  await p.waitForTimeout(1200);
  const box=await p.locator('#dropzone').boundingBox();
  const box2=await p.locator('#prescription').boundingBox();
  console.log('#dropzone box', JSON.stringify(box));
  console.log('#prescription box', JSON.stringify(box2));
  console.log('#dropzone count', await p.locator('#dropzone').count(), '| #prescription count', await p.locator('#prescription').count());
  console.log('prescription 前 40 字:', (await p.textContent('#prescription')).slice(0,40));
  // 视口截图（不滚动）
  await p.screenshot({path:'/tmp/sonic-shots/midi/vp-top.png'});
  await p.locator('#dropzone').screenshot({path:'/tmp/sonic-shots/midi/el-drop.png'});
  console.log('ok');
  await b.close();
})().catch(e=>{console.error(e.message);process.exit(1)});
