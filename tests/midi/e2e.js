const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const path=require('path'), fs=require('fs');
const OUT='/tmp/sonic-shots/midi/out';
fs.mkdirSync(OUT,{recursive:true});
const fail=[]; const ok=(c,m)=>{ console.log((c?'  ✓ ':'  ✗ ')+m); if(!c) fail.push(m); };

function parseMidi(b){
  if(b.toString('ascii',0,4)!=='MThd') return {err:'no MThd'};
  const fmt=b.readUInt16BE(8), ntrk=b.readUInt16BE(10), div=b.readUInt16BE(12);
  let off=14, tracks=[];
  for(let i=0;i<ntrk;i++){
    if(b.toString('ascii',off,off+4)!=='MTrk'){tracks.push({err:'bad'});break;}
    const len=b.readUInt32BE(off+4);
    tracks.push(parseTrack(b,off+8,off+8+len)); off+=8+len;
  }
  return {fmt,ntrk,div,tracks,endOk:off===b.length};
}
function parseTrack(b,s,e){
  let p=s,tick=0,running=0,on=0,off=0,name='',prog=null,ts=[],tempos=[],vel=[],chans=new Set(),pitches=new Set();
  const rdVar=()=>{let v=0,c;do{c=b[p++];v=(v<<7)|(c&0x7f);}while(c&0x80);return v;};
  while(p<e){
    tick+=rdVar();
    let st=b[p];
    if(st&0x80){p++;running=st;}else st=running;
    if(st===0xff){const type=b[p++],len=rdVar();const d=b.slice(p,p+len);p+=len;
      if(type===0x03)name=d.toString('utf8');
      if(type===0x58)ts.push(d[0]+'/'+(1<<d[1]));
      if(type===0x51)tempos.push(Math.round(60000000/((d[0]<<16)|(d[1]<<8)|d[2])));
      if(type===0x2f)break;
    } else if(st===0xf0||st===0xf7){p+=rdVar();}
    else {const hi=st&0xf0;chans.add(st&0x0f);
      if(hi===0xc0)prog=b[p++];
      else if(hi===0xd0)p+=1;
      else{const a=b[p++],c2=b[p++];
        if(hi===0x90&&c2>0){on++;vel.push(c2);pitches.add(a);}
        if(hi===0x80||(hi===0x90&&c2===0))off++;}}
  }
  return {tick,name,prog,ts,tempos,on,off,chans:[...chans],
    velSet:[...new Set(vel)].sort((a,b)=>a-b),pitch:pitches.size};
}
function wavInfo(p){
  const b=fs.readFileSync(p);
  const ch=b.readUInt16LE(22), sr=b.readUInt32LE(24), bits=b.readUInt16LE(34), data=b.readUInt32LE(40);
  const actual=b.length-44;
  const stride=ch*bits/8;
  // RMS（16/24 位通用）
  let sum=0,n=0,peak=0;
  const bytes=bits/8;
  for(let i=44;i<44+actual-stride+1;i+=stride*7){ // 抽样，够比对用
    for(let c=0;c<ch;c++){
      let v=0;
      for(let k=0;k<bytes;k++) v |= b[i+c*bytes+k]<<(8*k);
      if(bytes===3&&v&0x800000) v|=~0xffffff;
      if(bytes===2&&v&0x80000) v|=~0xffff;
      const s=v/((1<<(bytes*8-1))-1);
      sum+=s*s; n++; peak=Math.max(peak,Math.abs(s));
    }
  }
  return {sig:b.toString('ascii',0,4),bits,ch,sr,data,actual,ok:b.toString('ascii',0,4)==='RIFF'&&bits>0&&data===actual&&data%stride===0,
    rms:n?Math.sqrt(sum/n):0,peak};
}
const checkWav=(p)=>wavInfo(p).ok;

(async()=>{
  const b=await chromium.launch({executablePath:EXEC,args:['--no-sandbox']});
  const ctx=await b.newContext({viewport:{width:1440,height:900},acceptDownloads:true});
  const p=await ctx.newPage();
  p.on('pageerror',e=>{console.log('PAGEERROR:',e.message);fail.push('pageerror: '+e.message);});
  p.on('console',m=>{if(m.type()==='error')console.log('CONSOLE:',m.text());});
  await p.goto('http://127.0.0.1:8080/?fresh=1&synth=1',{waitUntil:'networkidle'});

  await p.click('#btnDemo');
  await p.waitForFunction(()=>document.querySelector('#mBpm')?.textContent.trim()!=='—',null,{timeout:180000});
  console.log('\n[1] 体检完成\n');

  // ---- 素材类型控件 ----
  const chips=await p.$$eval('#sourceKind .chip',els=>els.map(e=>({t:e.textContent.trim(),a:e.getAttribute('aria-checked')})));
  console.log('  素材类型 chips:',JSON.stringify(chips));
  ok(chips.length===2,'有 2 个素材类型选项');
  ok(chips.some(c=>c.t.includes('AI 生成音乐')),'有「AI 生成音乐」');
  ok(chips.some(c=>c.t.includes('真实录音')),'有「真实录音」');
  const active0=chips.find(c=>c.a==='true'); ok(active0&&active0.t.includes('AI'),'默认选中 AI 生成音乐');
  const hint0=(await p.textContent('#kindHint')).trim();
  ok(hint0.length>10,'kindHint 有实测说明: '+hint0.slice(0,48)+'…');
  const rx0=await p.$$eval('#prescription li',els=>els.map(e=>e.textContent.trim()));
  console.log('  AI 链处方:',rx0.map(s=>s.slice(0,30)));
  ok(rx0.some(s=>s.includes('还原')||s.includes('生成链')),'AI 链处方是「还原」口径');

  // ---- 链 A：AI 生成音乐 ----
  console.log('\n[2] 链 A · AI 生成音乐');
  await p.click('#btnProcess');
  await p.waitForFunction(()=>!document.querySelector('#btnExportProcessed').disabled,null,{timeout:120000});
  let [d]=await Promise.all([p.waitForEvent('download'),p.click('#btnExportProcessed')]);
  const fAi=path.join(OUT,'chain_ai.wav'); await d.saveAs(fAi);
  const wAi=wavInfo(fAi);
  ok(wAi.ok&&wAi.bits===24,`AI 链精修 WAV 24位通过 (bits=${wAi.bits} rms=${wAi.rms.toFixed(4)})`);

  // ---- 切到 真实录音 ----
  console.log('\n[3] 切换到 真实录音');
  await p.click('#sourceKind .chip:has-text("真实录音")');
  const chips1=await p.$$eval('#sourceKind .chip',els=>els.map(e=>({t:e.textContent.trim(),a:e.getAttribute('aria-checked')})));
  const act1=chips1.find(c=>c.a==='true');
  ok(act1&&act1.t.includes('真实录音'),'aria-checked 跟到「真实录音」上');
  const rx1=await p.$$eval('#prescription li',els=>els.map(e=>e.textContent.trim()));
  console.log('  录音链处方:',rx1.map(s=>s.slice(0,30)));
  ok(JSON.stringify(rx0)!==JSON.stringify(rx1),'处方随素材类型变了');
  ok(rx1.some(s=>s.includes('压缩')||s.includes('底噪')),'录音链是「修复」口径');
  const st=await p.textContent('#heroStatus')||''; const st2=await p.textContent('#dropStatus')||'';
  const statusText=(st+st2).trim();
  console.log('  状态条:',statusText.slice(0,80));
  ok(statusText.includes('真实录音')||statusText.length>0,'切换有状态回执');

  await p.click('#btnProcess');
  await p.waitForFunction(()=>!document.querySelector('#btnExportProcessed').disabled,null,{timeout:120000});
  [d]=await Promise.all([p.waitForEvent('download'),p.click('#btnExportProcessed')]);
  const fAc=path.join(OUT,'chain_acoustic.wav'); await d.saveAs(fAc);
  const wAc=wavInfo(fAc);
  ok(wAc.ok&&wAc.bits===24,`录音链精修 WAV 24位通过 (bits=${wAc.bits} rms=${wAc.rms.toFixed(4)})`);

  const aBuf=fs.readFileSync(fAi), cBuf=fs.readFileSync(fAc);
  ok(!aBuf.equals(cBuf),'两条链产出的音频字节不同（分治确实生效）');
  const dr=Math.abs(wAi.rms-wAc.rms);
  console.log(`  AI 链 rms=${wAi.rms.toFixed(4)} peak=${wAi.peak.toFixed(3)} | 录音链 rms=${wAc.rms.toFixed(4)} peak=${wAc.peak.toFixed(3)} | Δrms=${dr.toExponential(2)}`);
  ok(dr>1e-4,'两条链响度/动态有可测差异');
  // 两条链都归一到 -0.3 dBFS，峰值本来就该几乎一样；
  // 真正能说明分治生效的是波峰因数：AI 链做了向上还原（起伏更大），
  // 录音链挂了压缩（波形被压平）。
  const crest=(w)=>20*Math.log10(w.peak/w.rms);
  const cAi=crest(wAi), cAc=crest(wAc);
  console.log(`  波峰因数 AI=${cAi.toFixed(2)}dB 录音=${cAc.toFixed(2)}dB Δ=${Math.abs(cAi-cAc).toFixed(2)}dB`);
  ok(Math.abs(cAi-cAc)>0.5,`两条链波峰因数差 ${Math.abs(cAi-cAc).toFixed(2)}dB（AI 保留动态 / 录音压缩）`);

  // ---- 渲染 + MIDI ----
  console.log('\n[4] 渲染乐段 + 导出 MIDI');
  await p.click('#btnRender');
  await p.waitForFunction(()=>document.querySelector('#btnRender').textContent==='重新渲染'&&!document.querySelector('#btnRender').disabled,null,{timeout:120000});
  let md;
  [d]=await Promise.all([p.waitForEvent('download'),p.click('#btnExportMidi')]);
  const fm=path.join(OUT,d.suggestedFilename()); await d.saveAs(fm);
  console.log('  文件:',d.suggestedFilename(), fs.statSync(fm).size,'bytes');
  ok(d.suggestedFilename().endsWith('.mid'),'导出名是 .mid');
  const m=parseMidi(fs.readFileSync(fm));
  ok(m.fmt===1,`SMF format=1（实为 ${m.fmt}）`);
  ok(m.div===480,`division=480（实为 ${m.div}）`);
  ok(m.ntrk===6,`ntrk=6（实为 ${m.ntrk}）`);
  ok(m.endOk,'MIDI 文件尾对齐');
  const inst=m.tracks.slice(1);
  const names=inst.map(t=>t.name);
  console.log('  轨:',JSON.stringify(inst.map(t=>({n:t.name,prog:t.prog,ch:t.chans,on:t.on,v:t.velSet.length}))));
  for(const w of ['主旋','和声','贝斯','鼓组','氛围']) ok(names.includes(w),`有乐器轨「${w}」`);
  const drums=inst.find(t=>t.name==='鼓组');
  ok(drums&&drums.chans.length===1&&drums.chans[0]===9,'鼓组独占通道 9');
  const melo=inst.filter(t=>t.name!=='鼓组');
  ok(melo.every(t=>t.prog!=null),'每条旋律轨都有 program change');
  ok(new Set(melo.map(t=>t.chans[0])).size===melo.length,'旋律轨通道不撞车');
  ok(inst.every(t=>t.on===t.off&&t.on>0),'note on/off 配对且非空');
  const allv=inst.flatMap(t=>t.velSet);
  ok(!inst.some(t=>t.velSet.length===1&&t.velSet[0]===100),'没有全 100 的死力度轨');
  ok(new Set(allv).size>=4,`力度区分 ${new Set(allv).size} 档`);
  const cond=m.tracks[0];
  ok(cond.tempos.length===1&&cond.tempos[0]>40&&cond.tempos[0]<240,'conductor 带速度 '+cond.tempos[0]);
  ok(cond.ts.length===1,'conductor 带拍号 '+cond.ts);
  const bpmTxt=await p.textContent('#bpmOut');
  ok(String(cond.tempos[0])===bpmTxt.match(/\d+/)?.[0],'MIDI 速度与界面 BPM 一致 ('+bpmTxt+')');

  // ---- 分轨 ZIP ----
  console.log('\n[5] 导出分轨 ZIP');
  [d]=await Promise.all([p.waitForEvent('download'),p.click('#btnExportStems')]);
  const fz=path.join(OUT,d.suggestedFilename()); await d.saveAs(fz);
  console.log('  文件:',d.suggestedFilename(),fs.statSync(fz).size,'bytes');
  ok(/_分轨\.zip$/.test(d.suggestedFilename()),'分轨是单个 zip（不是 5 个散文件）');
  ok(fs.readFileSync(fz).subarray(0,2).toString()==='PK','zip 签名正确');

  // ---- 存盘：material 是否回流 ----
  console.log('\n[6] 刷新后恢复素材类型');
  await p.waitForTimeout(2500);
  // 必须去掉 ?fresh=1：那个参数每次加载都清库，刷新等于把刚存的又抹了
  await p.goto('http://127.0.0.1:8080/', {waitUntil:'networkidle'});
  try {
    await p.waitForFunction(()=>!!document.querySelector('#sourceKind .chip'),null,{timeout:180000});
    await p.waitForFunction(()=>document.querySelector('#mBpm')?.textContent.trim()!=='—',null,{timeout:180000});
  } catch(e) {
    console.log('  恢复超时，现场状态:');
    console.log('   saveStatus:',(await p.textContent('#saveStatus')||'').trim());
    console.log('   dropStatus:',(await p.textContent('#dropStatus')||'').trim());
    console.log('   mBpm:',(await p.textContent('#mBpm')||'').trim());
    console.log('   refineHidden:',await p.getAttribute('#refineBody','hidden'));
    console.log('   chips:',await p.$$eval('#sourceKind .chip',e=>e.length));
    console.log('   状态条:',(await p.textContent('#heroStatusText')||'').trim());
    throw e;
  }
  const chips2=await p.$$eval('#sourceKind .chip',els=>els.map(e=>({t:e.textContent.trim(),a:e.getAttribute('aria-checked')})));
  const act2=chips2.find(c=>c.a==='true');
  console.log('  恢复后选中:',act2&&act2.t);
  ok(act2&&act2.t.includes('真实录音'),'刷新后素材类型仍是「真实录音」');

  // 截图
  await p.locator('#refineBody').scrollIntoViewIfNeeded();
  await p.waitForTimeout(600);
  await p.screenshot({path:'/tmp/sonic-shots/midi/refine-kind.png'});
  console.log('  截图: /tmp/sonic-shots/midi/refine-kind.png');

  await b.close();
  console.log('\n'+(fail.length?'FAIL ('+fail.length+')':'E2E 全绿'));
  if(fail.length){fail.forEach(f=>console.log('  ✗ '+f));process.exit(1);}
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
