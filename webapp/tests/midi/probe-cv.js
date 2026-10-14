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

    // 复刻新的分窗相位
    const W=64,HOP=32;
    const winK0=[];for(let k0=0;k0<nBeats;k0+=HOP)winK0.push(k0);
    const nWin=winK0.length;
    const frac=new Float64Array(nWin), valid=new Uint8Array(nWin), weight=new Float64Array(nWin);
    const concs=[];
    for(let w=0;w<nWin;w++){
      const i0=Math.max(0,Math.floor(winK0[w]*beatLag));
      const i1=Math.min(n-1,Math.ceil((winK0[w]+W)*beatLag));
      let x=0,y=0,sw=0;
      for(let i=i0;i<=i1;i++){const v=env[i];if(v<=0)continue;
        const a=2*Math.PI*i/beatLag;x+=v*Math.cos(a);y+=v*Math.sin(a);sw+=v;}
      if(sw<=1e-12){frac[w]=0;valid[w]=0;weight[w]=0;concs.push(0);continue;}
      frac[w]=Math.atan2(y,x)/(2*Math.PI);
      const c=Math.hypot(x,y)/sw; concs.push(+(c.toFixed(3)));
      valid[w]=c>0.04?1:0; weight[w]=sw*c;
    }
    let prev=NaN;
    for(let w=0;w<nWin;w++){
      if(!valid[w])continue;
      if(!Number.isNaN(prev)){while(frac[w]-prev>0.5)frac[w]-=1;while(prev-frac[w]>0.5)frac[w]+=1;}
      prev=frac[w];
    }
    const driftCurve=winK0.map((k0,i)=>({k0,frac:+frac[i].toFixed(3),valid:valid[i],conc:concs[i]}));

    // 插值到每拍
    const f=new Float64Array(nBeats);
    const cb=w=>winK0[w]+W/2;
    for(let k=0;k<nBeats;k++){
      let w1=0;while(w1+1<nWin&&cb(w1+1)<k)w1++;
      const w0=w1;
      if(w1+1<nWin){
        const c0=cb(w0),c1=cb(w1+1);
        const u=(k-c0)/Math.max(c1-c0,1);
        f[k]=frac[w0]+(frac[w1+1]-frac[w0])*Math.min(Math.max(u,0),1);
      } else f[k]=frac[w0];
    }
    const s=[];for(let k=0;k<nBeats;k++)s.push(pos((k+f[k])*beatLag));

    // 每半段：4 拍周期下哪个 offset 是「强拍」
    const downPhase=(a,b)=>{
      const sums=[0,0,0,0],cnt=[0,0,0,0];
      for(let k=a;k<b;k++){const i=k%4;sums[i]+=s[k];cnt[i]++;}
      return sums.map((v,i)=>+(v/cnt[i]).toFixed(4));
    };
    const half=Math.floor(nBeats/2);
    // 模板循环移位后的最大相关
    const pear=(a,b)=>{const m=a.length;let ma=0,mb=0;for(let i=0;i<m;i++){ma+=a[i];mb+=b[i];}ma/=m;mb/=m;
      let num=0,da=0,db=0;for(let i=0;i<m;i++){const x=a[i]-ma,y=b[i]-mb;num+=x*y;da+=x*x;db+=y*y;}
      return da>0&&db>0?num/Math.sqrt(da*db):0;};
    const tmpl=[1.0,0.55,0.76,0.55];
    const means=downPhase(0,nBeats);
    let bestR=-2,bestSh=0;
    for(let sh=0;sh<4;sh++){const sp=means.map((_,i)=>means[(i+sh)%4]);const r=pear(sp,tmpl);
      if(r>bestR){bestR=r;bestSh=sh;}}
    // 分段 s 的均值/能量对比（看前后半是否结构变了）
    const m1=s.slice(0,half).reduce((a,b)=>a+b,0)/half;
    const m2=s.slice(half).reduce((a,b)=>a+b,0)/(s.length-half);
    return {bpm,nBeats,driftCurve,binMeans_full:means,
      firstHalf:downPhase(0,half),secondHalf:downPhase(half,nBeats),
      templateShiftBest:bestSh, templateR:+bestR.toFixed(3),
      meanFirst:+m1.toFixed(4),meanSecond:+m2.toFixed(4)};
  });
  console.log(JSON.stringify(out,null,1));
  await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
