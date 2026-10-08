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
    const s=[];for(let k=0;k<nBeats;k++)s.push(pos(k*beatLag));
    const m=s.reduce((a,b)=>a+b,0)/s.length;
    let var0=0;for(const v of s)var0+=(v-m)**2;
    const ac=(lag)=>{let num=0;for(let k=0;k+lag<s.length;k++)num+=(s[k]-m)*(s[k+lag]-m);return num/var0;};
    // 周期拟合 r2，B=4
    const B=4;
    const p4=new Array(B).fill(0),c4=new Array(B).fill(0);
    for(let k=0;k<s.length;k++){p4[k%B]+=s[k];c4[k%B]++;}
    for(let i=0;i<B;i++)p4[i]/=c4[i];
    let sse=0;for(let k=0;k<s.length;k++)sse+=(s[k]-p4[k%B])**2;
    const r2=1-sse/var0;
    // 分解：每 bin 均值的方差占比
    let varP=0;for(let k=0;k<s.length;k++)varP+=(p4[k%B]-m)**2;
    // 逐 4 拍分组的序列（每 4 拍压成 1 点 = downbeat 序列）
    const down=[];for(let k=0;k<s.length;k+=4)down.push(s[k]);
    const dm=down.reduce((a,b)=>a+b,0)/down.length;
    let dvar=0;for(const v of down)dvar+=(v-dm)**2;
    let dac1=0;for(let k=0;k+1<down.length;k++)dac1+=(down[k]-dm)*(down[k+1]-dm);
    // s 的分位数 & 是否稀疏
    const sorted=s.slice().sort((a,b)=>a-b);
    const q=(f)=>+sorted[Math.floor(f*(sorted.length-1))].toFixed(4);
    return {
      nBeats, beatLag:+beatLag.toFixed(2),
      ac1:+ac(1).toFixed(3), ac2:+ac(2).toFixed(3), ac3:+ac(3).toFixed(3), ac4:+ac(4).toFixed(3), ac8:+ac(8).toFixed(3),
      r2_B4:+r2.toFixed(4), varPfrac:+(varP/var0).toFixed(4),
      p4:p4.map(x=>+x.toFixed(4)),
      downLen:down.length, downAC1:+(dac1/dvar).toFixed(3),
      quantiles:{q0:q(0),q25:q(.25),q50:q(.5),q75:q(.75),q90:q(.9),q99:q(.99),q100:q(1)},
      zeroFrac:+(s.filter(x=>x===0).length/s.length).toFixed(3),
    };
  });
  console.log(JSON.stringify(out,null,1));
  await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
