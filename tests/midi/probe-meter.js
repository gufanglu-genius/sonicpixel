const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC='/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
(async()=>{
  const b=await chromium.launch({executablePath:EXEC,args:['--no-sandbox']});
  const p=await b.newPage();
  await p.goto('http://127.0.0.1:8080/',{waitUntil:'networkidle'});
  const out=await p.evaluate(async()=>{
    const E=window.SonicEngine;
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    const rep={};
    for (const url of ['assets/ai-song-demo.flac']) {
      const res=await fetch(url); const ab=await res.arrayBuffer();
      const buf=await ctx.decodeAudioData(ab.slice(0));
      const pcm=buf.getChannelData(0);
      const t0=performance.now();
      const beat=E._internals.estimateBPM(pcm, buf.sampleRate);
      const t1=performance.now();
      const meter=E._internals.estimateMeter(beat.envelope, beat.envFps, beat.bpm);
      rep[url]={
        dur:Math.round(buf.duration*10), sr:buf.sampleRate,
        bpm:beat.bpm, conf:beat.confidence, envLen:beat.envelope.length, fps:Math.round(beat.envFps),
        ms:Math.round(t1-t0),
        meter:meter.meter, meterConf:meter.confidence,
        scores:meter.scores,
      };
    }
    return rep;
  });
  console.log(JSON.stringify(out,null,1));
  await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
