const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC='/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
(async()=>{
  const b=await chromium.launch({executablePath:EXEC,args:['--no-sandbox']});
  const p=await b.newPage();
  await p.goto('http://127.0.0.1:8080/',{waitUntil:'networkidle'});
  const out=await p.evaluate(async()=>{
    const E=window.SonicEngine;
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    const res={};
    for (const url of ['assets/ai-song-demo.flac']) {
      const buf=await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
      const beat=E._internals.estimateBPM(buf.getChannelData(0), buf.sampleRate);
      const meter=E._internals.estimateMeter(beat.envelope, beat.envFps, beat.bpm);
      res[url]={bpm:beat.bpm,meter:meter.meter,conf:meter.confidence};
    }
    return res;
  });
  console.log('browser:', JSON.stringify(out));

  // 红头绳走完整 analyze（含调式/调性字段）
  const out2 = await p.evaluate(async(filePath)=>{
    // 通过页面 file input 无法直接喂路径 —— 改用 fetch 不行（本地文件）。
    // 走 _internals 直接算：由 Playwright 读文件字节塞进来。
    return null;
  });
  await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
