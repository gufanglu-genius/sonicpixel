const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC='/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const T=(s)=>(s||'').trim();
(async()=>{
  const b=await chromium.launch({executablePath:EXEC,args:['--no-sandbox']});
  const p=await b.newPage({viewport:{width:1440,height:1000}});
  p.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  p.on('console',m=>{if(m.type()==='error')console.log('CONSOLE:',m.text())});
  const t0=Date.now();
  await p.goto('http://127.0.0.1:8080/?fresh=1',{waitUntil:'networkidle'});
  await p.click('#btnDemo');
  await p.waitForFunction(()=>document.querySelector('#mBpm')?.textContent.trim()!=='—',null,{timeout:240000});
  console.log('载入+体检', ((Date.now()-t0)/1000).toFixed(1)+'s');
  const d=await p.evaluate(()=>{
    const g=(s)=>document.querySelector(s)?.textContent?.trim();
    return {
      status:g('#dropStatus')||g('#heroStatusText'),
      bpm:g('#mBpm'), meter:g('#mMeter'), dur:g('#mDur'), sr:g('#mSr'),
      thd:g('#mThd'), lra:g('#mLra'), cent:g('#mCent'), crest:g('#mCrest'),
      mud:g('#mMud'), mudSub:g('#mMudSub'),
      mode:g('#modeName'), glyph:g('#modeGlyph'),
      modeChips:[...document.querySelectorAll('#modeChips .chip')].map(e=>e.textContent.trim()),
      structure:g('#structureLegend'),
      kindHint:g('#kindHint'),
      prescription:[...document.querySelectorAll('#prescription li, #prescription .prescription-item')].map(e=>e.textContent.replace(/\s+/g,' ').trim()),
      strategy:[...document.querySelectorAll('#styleModeChips .chip')].map(e=>e.textContent.replace(/\s+/g,' ').trim()),
      eq:[...document.querySelectorAll('#eqBands input')].map(i=>i.value),
      dropCopy:document.querySelector('#dropzone p')?.textContent.replace(/\s+/g,' ').trim(),
      checkTitle:g('.mode-dial')?'':''
    };
  });
  console.log(JSON.stringify(d,null,1));
  await p.screenshot({path:'/tmp/sonic-shots/midi/new-check.png',fullPage:false});
  await b.close();
})().catch(e=>{console.error('FAIL',e.message);process.exit(1)});
