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
    // 全部局部极大（不设阈值，NMS 0.11s），峰高做权重
    const peaks=[];
    for(let i=1;i<n-1;i++){
      if(env[i]>0 && env[i]>=env[i-1] && env[i]>env[i+1]){
        if(peaks.length && i-peaks[peaks.length-1].t < fps*0.11){
          if(env[i]>peaks[peaks.length-1].w) peaks[peaks.length-1]={t:i,w:env[i]};
        } else peaks.push({t:i,w:env[i]});
      }
    }
    // Rayleigh 集中度：给定周期 tau（帧），权重环上向量的合向量长度
    const conc=(ps,tau)=>{
      let x=0,y=0,sw=0;
      for(const pk of ps){const a=2*Math.PI*pk.t/tau;x+=pk.w*Math.cos(a);y+=pk.w*Math.sin(a);sw+=pk.w;}
      return sw>0 ? Math.hypot(x,y)/sw : 0;
    };
    // 周期扫描：50–330 BPM
    const cands=[];
    for(let bpm=50;bpm<=330;bpm+=1){
      const tau=(60/bpm)*fps;
      cands.push({bpm,tau});
    }
    const windows=[
      ['全曲',peaks],
      ['前 30s',peaks.filter(p=>p.t/fps<30)],
      ['中段',peaks.filter(p=>p.t/fps>87&&p.t/fps<117)],
      ['后 30s',peaks.filter(p=>p.t/fps>174)],
    ];
    const bestFor=(ps)=>{
      let best=null, rows=[];
      for(const c of cands){
        const v=conc(ps,c.tau);
        rows.push({bpm:c.bpm,v:+v.toFixed(4)});
      }
      rows.sort((a,b)=>b.v-a.v);
      return rows.slice(0,12);
    };
    const res={nPeaks:peaks.length,windows:{}};
    for(const [name,ps] of windows){
      res.windows[name]={n:ps.length,top:bestFor(ps)};
    }
    // 160 vs 80 vs 321 集中度对比（全曲 + 各窗）
    res.compare={};
    for(const bpm of [80,80.4,120,160.4,160.8,161,162,321]){
      const tau=(60/bpm)*fps;
      res.windows && (res.compare[bpm]={});
      for(const [name,ps] of windows) res.compare[bpm][name]=+conc(ps,tau).toFixed(4);
    }
    return res;
  });
  console.log(JSON.stringify(out,null,1));
  await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
