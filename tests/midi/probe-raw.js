const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC='/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
(async()=>{
  const b=await chromium.launch({executablePath:EXEC,args:['--no-sandbox']});
  const p=await b.newPage();
  await p.goto('http://127.0.0.1:8080/',{waitUntil:'networkidle'});
  const out=await p.evaluate(async()=>{
    const E=window.SonicEngine;
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    const resp=await fetch('assets/ai-song-demo.flac');
    const buf=await ctx.decodeAudioData(await resp.arrayBuffer());
    const beat=E._internals.estimateBPM(buf.getChannelData(0), buf.sampleRate);
    const env=beat.envelope, fps=beat.envFps, n=env.length;
    // 1. 起音峰检测：env 局部峰 + 高度阈值 → IOI 直方图
    const peaks=[];
    for(let i=2;i<n-2;i++){
      if(env[i]>0.05 && env[i]>=env[i-1] && env[i]>env[i+1] && env[i]>env[i-2] && env[i]>env[i+2]){
        // 非极大抑制：0.1s 内只留最高
        if(peaks.length && i-peaks[peaks.length-1] < fps*0.08){
          if(env[i]>env[peaks[peaks.length-1]]) peaks[peaks.length-1]=i;
        } else peaks.push(i);
      }
    }
    const iois={};
    for(let k=1;k<peaks.length;k++){
      const dt=(peaks[k]-peaks[k-1])/fps;
      if(dt<0.15||dt>2.0) continue;
      const key=(Math.round(dt*100)/100).toFixed(2);
      iois[key]=(iois[key]||0)+1;
    }
    const ioiTop=Object.entries(iois).sort((a,b)=>b[1]-a[1]).slice(0,15);
    // 2. 前 96 拍的 s 值（相位 0）
    const bpm=beat.bpm, beatLag=(60/bpm)*fps;
    const wL=Math.max(1,Math.floor(beatLag*0.18)), wR=Math.max(1,Math.ceil(beatLag*0.22));
    const pos=(c)=>{c=Math.round(c);let a=0;
      for(let i=Math.max(0,c-wL);i<=Math.min(n-1,c+wR);i++){const v=env[i];if(v>0)a+=v;}return a;};
    const s96=[];for(let k=0;k<96;k++)s96.push(+pos(k*beatLag).toFixed(3));
    // 3. 峰间距 vs 网格：起音峰相对最近网格拍的偏移（秒），看网格是否漂移
    const offs=[];for(const pk of peaks){
      const beatPos=pk/beatLag; const frac=beatPos-Math.floor(beatPos);
      offs.push(frac);
    }
    const hist=new Array(10).fill(0);
    for(const o of offs)hist[Math.min(9,Math.floor(o*10))]++;
    return {bpm:+bpm.toFixed(2),fps:+fps.toFixed(1),nPeaks:peaks.length,
      ioiTop, s96, gridOffsetDeciles:hist};
  });
  console.log(JSON.stringify(out,null,1));
  await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
