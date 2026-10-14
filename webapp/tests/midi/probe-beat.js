const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC='/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
(async()=>{
  const b=await chromium.launch({executablePath:EXEC,args:['--no-sandbox']});
  const p=await b.newPage();
  await p.goto('http://127.0.0.1:8080/',{waitUntil:'networkidle'});
  const out=await p.evaluate(async()=>{
    const E=window.SonicEngine;
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    const res=await fetch('assets/ai-song-demo.flac');
    const buf=await ctx.decodeAudioData(await res.arrayBuffer());
    const pcm=buf.getChannelData(0);
    const beat=E._internals.estimateBPM(pcm, buf.sampleRate);
    // 自建拍网格打分：对候选 BPM 扫描，看周期结构藏在哪
    const env=beat.envelope, fps=beat.envFps, n=env.length;
    const scan=(bpm,B)=>{
      const beatLag=(60/bpm)*fps;
      if(!(beatLag>=2)||beatLag>n/2) return null;
      const nBeats=Math.floor((n-1)/beatLag);
      if(nBeats<10) return null;
      const wL=Math.max(1,Math.floor(beatLag*0.18)), wR=Math.max(1,Math.ceil(beatLag*0.22));
      const pos=(c)=>{c=Math.round(c);let a=0;
        for(let i=Math.max(0,c-wL);i<=Math.min(n-1,c+wR);i++){const v=env[i];if(v>0)a+=v;}
        return a;};
      // 简单全局相位（不追踪），看周期性是否至少存在
      let bestR2=-1, bestPh=0;
      for(let ph=0;ph<B;ph++){
        const s=[];
        for(let k=0;k<nBeats;k++) s.push(pos(k*beatLag+ph*beatLag/B));
        const m=s.reduce((a,b)=>a+b,0)/s.length;
        let sse=0,sst=0; const p=new Array(B).fill(0),c=new Array(B).fill(0);
        for(let k=0;k<s.length;k++){const bb=(k+ph)%B;p[bb]+=s[k];c[bb]++;}
        for(let i=0;i<B;i++)p[i]/=Math.max(c[i],1);
        for(let k=0;k<s.length;k++){sse+=(s[k]-p[(k+ph)%B])**2;sst+=(s[k]-m)**2;}
        const r2=1-sse/sst; if(r2>bestR2){bestR2=r2;bestPh=ph;}
      }
      return bestR2;
    };
    const rows=[];
    for(const bpm of [80.4,107.2,120,134,145,160.8,174,180,192,214]){
      const row={bpm};
      for(const B of [2,3,4]) row['B'+B]=+(scan(bpm,B)?.toFixed(3) ?? 'null');
      rows.push(row);
    }
    // s[] 序列的自相关（在 160.8 下），看周期是不是半拍/两拍错位
    const beatLag=(60/160.8)*fps;
    const nBeats=Math.floor((n-1)/beatLag);
    const wL=Math.max(1,Math.floor(beatLag*0.18)), wR=Math.max(1,Math.ceil(beatLag*0.22));
    const pos=(c)=>{c=Math.round(c);let a=0;
      for(let i=Math.max(0,c-wL);i<=Math.min(n-1,c+wR);i++){const v=env[i];if(v>0)a+=v;}return a;};
    const s=[];for(let k=0;k<nBeats;k++)s.push(pos(k*beatLag));
    const mean=s.reduce((a,b)=>a+b,0)/s.length;
    const ac=[];for(let lag=1;lag<=16;lag++){
      let num=0;for(let k=0;k+lag<s.length;k++)num+=(s[k]-mean)*(s[k+lag]-mean);
      ac.push(+(num/(s.length-mean*mean*0+1e-9)/(s.length-lag)).toFixed(3));
    }
    // 归一化自相关
    let var0=0;for(const v of s)var0+=(v-mean)**2;
    const acn=[];for(let lag=1;lag<=16;lag++){
      let num=0;for(let k=0;k+lag<s.length;k++)num+=(s[k]-mean)*(s[k+lag]-mean);
      acn.push(+(num/var0).toFixed(3));
    }
    return {bpm:beat.bpm,conf:beat.confidence,fps:Math.round(fps),nBeats,rows,acn,beatKeys:Object.keys(beat)};
  });
  console.log(JSON.stringify(out,null,1));
  await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
