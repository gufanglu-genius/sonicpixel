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
    const env=beat.envelope, fps=beat.envFps, bpm=beat.bpm, n=env.length;
    const beatLag=(60/bpm)*fps, nBeats=Math.floor((n-1)/beatLag);
    const wL=Math.max(1,Math.floor(beatLag*0.18)), wR=Math.max(1,Math.ceil(beatLag*0.22));
    const pos=(c)=>{c=Math.round(c);let a=0;
      for(let i=Math.max(0,c-wL);i<=Math.min(n-1,c+wR);i++){const v=env[i];if(v>0)a+=v;}return a;};

    const fitR2=(sArr,B)=>{
      const m=sArr.reduce((a,b)=>a+b,0)/sArr.length;
      let sst=0;for(const v of sArr)sst+=(v-m)**2;
      let best=-1;
      for(let ph=0;ph<B;ph++){
        const p=new Array(B).fill(0),c=new Array(B).fill(0);
        for(let k=0;k<sArr.length;k++){const bb=(k+ph)%B;p[bb]+=sArr[k];c[bb]++;}
        for(let i=0;i<B;i++)p[i]/=Math.max(c[i],1);
        let sse=0;for(let k=0;k<sArr.length;k++)sse+=(sArr[k]-p[(k+ph)%B])**2;
        const r2=1-sse/sst; if(r2>best)best=r2;
      }
      return best;
    };
    // (a) 引擎同款追踪
    const trackPhase=()=>{
      const CH=8, span=Math.max(2,Math.round(beatLag*0.36));
      const phase=new Float64Array(nBeats), offs=[];
      for(let k0=0;k0<nBeats;k0+=CH){
        const k1=Math.min(nBeats,k0+CH);
        let bestOff=0,bestS=-Infinity;
        for(let off=-span;off<=span;off++){
          let acc=0;for(let k=k0;k<k1;k++)acc+=pos(k*beatLag+off);
          if(acc>bestS){bestS=acc;bestOff=off;}
        }
        offs.push(bestOff);
        for(let k=k0;k<k1;k++)phase[k]=bestOff;
      }
      return {phase,offs,span};
    };
    const {phase,offs,span}=trackPhase();
    const sTracked=[];for(let k=0;k<nBeats;k++)sTracked.push(pos(k*beatLag+phase[k]));
    // (b) 全局单相位（全曲一个 offset）
    let gBest=0,gs=-Infinity;
    for(let off=-span;off<=span;off++){let acc=0;for(let k=0;k<nBeats;k++)acc+=pos(k*beatLag+off);
      if(acc>gs){gs=acc;gBest=off;}}
    const sGlobal=[];for(let k=0;k<nBeats;k++)sGlobal.push(pos(k*beatLag+gBest));
    // (c) 相位 0
    const s0=[];for(let k=0;k<nBeats;k++)s0.push(pos(k*beatLag));
    // 统计
    const stat=(s)=>{const m=s.reduce((a,b)=>a+b,0)/s.length;
      const sd=Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/s.length);
      return {mean:+m.toFixed(3),cv:+(sd/m).toFixed(3),min:+Math.min(...s).toFixed(3),max:+Math.max(...s).toFixed(3)};};
    const posFrac=(()=>{let c=0;for(const v of env)if(v>0)c++;return +(c/env.length).toFixed(3);})();
    const outObj={
      bpm:+bpm.toFixed(2),beatLag:+beatLag.toFixed(1),nBeats,span,posFrac,
      offMin:Math.min(...offs),offMax:Math.max(...offs),offMean:+(offs.reduce((a,b)=>a+b,0)/offs.length).toFixed(1),
      offHist:Object.fromEntries([...new Set(offs)].sort((a,b)=>a-b).map(o=>[o,offs.filter(x=>x===o).length])),
      r2:{
        tracked:{B2:+fitR2(sTracked,2).toFixed(3),B3:+fitR2(sTracked,3).toFixed(3),B4:+fitR2(sTracked,4).toFixed(3)},
        global:{B2:+fitR2(sGlobal,2).toFixed(3),B3:+fitR2(sGlobal,3).toFixed(3),B4:+fitR2(sGlobal,4).toFixed(3)},
        phase0:{B2:+fitR2(s0,2).toFixed(3),B3:+fitR2(s0,3).toFixed(3),B4:+fitR2(s0,4).toFixed(3)},
      },
      stats:{tracked:stat(sTracked),global:stat(sGlobal),phase0:stat(s0)},
    };
    return outObj;
  });
  console.log(JSON.stringify(out,null,1));
  await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
