// 问题7 验证：真 renderArrangement 的 harm/pad 力度起伏 + 渲染增益同步
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC='/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
(async()=>{
  const b=await chromium.launch({executablePath:EXEC,args:['--no-sandbox']});
  const p=await b.newPage();
  await p.goto('http://127.0.0.1:8080/',{waitUntil:'networkidle'});
  const out=await p.evaluate(async()=>{
    const E=window.SonicEngine;
    const res=await E.renderArrangement({rootMidi:60,modeIndex:0,bpm:92,bars:8,muted:new Set(),meter:'4/4'});
    const byTrack={};
    for(const ev of res.events){
      (byTrack[ev.track] ||= new Set()).add(ev.vel);
    }
    const sets=Object.fromEntries(Object.entries(byTrack).map(([k,v])=>[k,[...v].sort((a,b)=>a-b)]));
    return { sets, nEvents: res.events.length, duration: res.duration };
  });
  console.log(JSON.stringify(out,null,1));
  const s=out.sets;
  const harmOK = (s.harm||[]).length>1;
  const padOK = (s.pad||[]).length>1;
  const allVar = ['lead','harm','bass','drums','pad'].every(t=>(s[t]||[]).length>1);
  console.log(`和声起伏: ${harmOK?'✓':'✗'} ${JSON.stringify(s.harm)}`);
  console.log(`氛围起伏: ${padOK?'✓':'✗'} ${JSON.stringify(s.pad)}`);
  console.log(`五轨全起伏: ${allVar?'✓':'✗'}`);
  await b.close();
  process.exit(allVar?0:1);
})().catch(e=>{console.error(e);process.exit(1)});
