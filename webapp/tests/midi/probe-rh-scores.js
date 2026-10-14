const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const fs = require('fs');
const EXEC='/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const FILE='/Users/chenhuidediannao/Desktop/红头绳.wav';
(async()=>{
  const bytes = fs.readFileSync(FILE);
  const b=await chromium.launch({executablePath:EXEC,args:['--no-sandbox']});
  const p=await b.newPage();
  await p.route('**/probe-rh.wav', r => r.fulfill({ status:200, body: bytes, contentType:'audio/wav' }));
  await p.goto('http://127.0.0.1:8080/',{waitUntil:'networkidle'});
  const out=await p.evaluate(async()=>{
    const E=window.SonicEngine;
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    const res=await fetch('probe-rh.wav');
    const buf=await ctx.decodeAudioData(await res.arrayBuffer());
    const nCh=buf.numberOfChannels, len=buf.length;
    let data;
    if(nCh===1){ data=buf.getChannelData(0); }
    else{
      data=new Float32Array(len);
      for(let c=0;c<nCh;c++){ const ch=buf.getChannelData(c); for(let i=0;i<len;i++) data[i]+=ch[i]; }
      for(let i=0;i<len;i++) data[i]/=nCh;
    }
    const beat=E._internals.estimateBPM(data, buf.sampleRate);
    const meter=E._internals.estimateMeter(beat.envelope, beat.envFps, beat.bpm);
    return { bpm:beat.bpm, meter:meter.meter, conf:meter.confidence, scores:meter.scores };
  });
  console.log(JSON.stringify(out,null,1));
  await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
