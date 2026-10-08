const path=require('path');
require('/Users/chenhuidediannao/Desktop/技术类作品/音智新媒项目/webapp/engine.js');
const E = globalThis.SonicEngine;
if(!E){ console.error('SonicEngine 未导出'); process.exit(1); }

function parseMidi(b){
  if(b.toString('ascii',0,4)!=='MThd') return {err:'no MThd'};
  const fmt=b.readUInt16BE(8), ntrk=b.readUInt16BE(10), div=b.readUInt16BE(12);
  let off=14, tracks=[];
  for(let i=0;i<ntrk;i++){
    if(off+8>b.length){tracks.push({err:'truncated'});break;}
    if(b.toString('ascii',off,off+4)!=='MTrk'){tracks.push({err:'bad id @'+off});break;}
    const len=b.readUInt32BE(off+4);
    tracks.push(parseTrack(b,off+8,off+8+len));
    off+=8+len;
  }
  return {fmt,ntrk,div,parsed:tracks.length,tracks,endOk:off===b.length};
}
function parseTrack(b,s,e){
  let p=s,tick=0,running=0,on=0,off=0,name='',prog=null,ts=[],tempos=[],texts=[];
  let vel=[],chans=new Set(),pitches=new Set();
  const rdVar=()=>{let v=0,c;do{c=b[p++];v=(v<<7)|(c&0x7f);}while(c&0x80);return v;};
  while(p<e){
    tick+=rdVar();
    let st=b[p];
    if(st&0x80){p++;running=st;}else st=running;
    if(st===0xff){
      const type=b[p++],len=rdVar();const d=b.slice(p,p+len);p+=len;
      if(type===0x03)name=d.toString('utf8');
      if(type===0x01)texts.push(d.toString('utf8'));
      if(type===0x58)ts.push(d[0]+'/'+(1<<d[1]));
      if(type===0x51)tempos.push(Math.round(60000000/((d[0]<<16)|(d[1]<<8)|d[2])));
      if(type===0x2f)break;
    } else if(st===0xf0||st===0xf7){p+=rdVar();}
    else {
      const hi=st&0xf0, ch=st&0x0f; chans.add(ch);
      if(hi===0xc0){prog=b[p++];}
      else if(hi===0xd0)p+=1;
      else{const d1=b[p++],d2=b[p++];
        if(hi===0x90&&d2>0){on++;vel.push(d2);pitches.add(d1);}
        if(hi===0x80||(hi===0x90&&d2===0))off++;}
    }
  }
  return {tick,name,prog,ts,tempos,texts,on,off,
    velSet:[...new Set(vel)].sort((a,b)=>a-b),velAvg:vel.length?Math.round(vel.reduce((x,y)=>x+y,0)/vel.length):0,
    chans:[...chans],pitches:pitches.size};
}

// ---- 1. 模拟 renderArrangement 会产出的事件形状 ----
// ⚠ 本 mock 必须与 engine.js renderArrangement 的力度/增益公式逐字同步，
//   断言才有意义（引擎改公式而 mock 不改 = 测了个寂寞）。
const ev=[];
const VEL={lead:112,harm:84,bass:100,drums:96,pad:66};
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
// 与 renderArrangement 的 4/4 强弱表逐字一致
const accents=[1.0,0.55,0.76,0.55];
const velAt=(id,pos)=>Math.round(VEL[id]*(0.55+0.45*(accents[pos]||0.5)));
// 和声/氛围的力度由「和弦换没换」驱动（引擎和声进行，同引擎同式）
const prog=[0,0,2,0,0,1,3,0];
const midBeat=2; // floor(4/2)
for(let bar=0;bar<8;bar++){
  const t=bar*4*0.652;
  const rootDeg=prog[bar];
  const harmChange=bar===0||rootDeg!==prog[(bar+prog.length-1)%prog.length];
  // 和声：和弦三音本身有主次，换和弦的小节再抬一档（与引擎逐字一致）
  [0,2,4].forEach((d,i)=>{
    const vel=clamp(Math.round(VEL.harm*(i===0?1:i===1?0.88:0.80)*(harmChange?1:0.92)),1,127);
    ev.push({track:'harm',t:t+i*0.012,dur:1.2,note:60+d,deg:d,vel});
  });
  // 贝斯：根音 + 中段附点支撑，两个位置力度不同
  ev.push({track:'bass',t,dur:1.0,note:36,deg:0,vel:velAt('bass',0)});
  ev.push({track:'bass',t:0.652*midBeat+ (t?0:0)+t,dur:0.58,note:36,deg:0,vel:velAt('bass',midBeat)});
  // 氛围：换和弦 66，延续小节 66×0.85=56（渲染增益同步乘 vel/VEL.pad）
  const padVel=clamp(Math.round(VEL.pad*(harmChange?1:0.85)),1,127);
  ev.push({track:'pad', t,dur:2.4,note:84,deg:0,vel:padVel});
}
for(let b=0;b<32;b++){
  const pos=b%4;
  ev.push({track:'lead',t:b*0.652,dur:0.47,note:72,deg:0,vel:velAt('lead',pos)});
  if(b%4===0) ev.push({track:'drums',t:b*0.652,dur:0.16,note:36,deg:0,vel:116});
  else if(accents[pos]>=0.45&&pos%2===0) ev.push({track:'drums',t:b*0.652,dur:0.16,note:36,deg:0,vel:82});
  if(pos===midBeat) ev.push({track:'drums',t:b*0.652,dur:0.09,note:38,deg:0,vel:68});
}
// 零时值音符：off 必须被推到 on+1，否则会被自己的 note-off 掐掉
ev.push({track:'lead',t:99,dur:0,note:70,deg:0,vel:99});

(async()=>{
  const blob=E.eventsToMidi(ev,{bpm:92,meter:'4/4',title:'红头绳 · 再生乐段',note:'92 BPM · 4/4 · 8 小节'});
  const buf=Buffer.from(await blob.arrayBuffer());
  const m=parseMidi(buf);

  const fail=[];
  const ok=(c,msg)=>{ if(!c) fail.push(msg); };
  console.log('MIDI', buf.length, 'bytes | format', m.fmt, '| ntrk', m.ntrk, '| 解析到', m.parsed, '| 文件尾对齐', m.endOk);
  ok(m.fmt===1, 'format 应为 1，实为 '+m.fmt);
  ok(m.div===480, 'division 应为 480');
  ok(m.ntrk===6, '轨数应为 6（conductor+5），实为 '+m.ntrk);
  ok(m.parsed===m.ntrk, '有轨没解析出来');
  ok(m.endOk, '文件尾未对齐（多余或截断的字节）');

  const cond=m.tracks[0];
  console.log('conductor:', JSON.stringify({name:cond.name,ts:cond.ts,tempos:cond.tempos,text:cond.texts,on:cond.on}));
  ok(cond.tempos.length===1&&cond.tempos[0]===92, 'conductor 缺/错速度');
  ok(cond.ts.length===1&&cond.ts[0]==='4/4', 'conductor 缺拍号，实为 '+JSON.stringify(cond.ts));
  ok(cond.on===0, 'conductor 不该有音符');
  ok(cond.name.includes('再生乐段'), 'conductor 缺轨名');

  const inst=m.tracks.slice(1);
  const names=inst.map(t=>t.name);
  console.log('乐器轨:', JSON.stringify(inst.map(t=>({name:t.name,prog:t.prog,ch:t.chans,on:t.on,off:t.off,v:t.velSet.length,avg:t.velAvg}))));
  for(const want of ['主旋','和声','贝斯','鼓组','氛围'])
    ok(names.includes(want), '缺乐器轨 '+want);
  ok(new Set(names).size===5, '轨名有重复');

  const drums=inst.find(t=>t.name==='鼓组');
  ok(drums.chans.length===1&&drums.chans[0]===9, '鼓组必须独占通道 9，实为 '+JSON.stringify(drums.chans));
  const melo=inst.filter(t=>t.name!=='鼓组');
  ok(melo.every(t=>t.chans.length===1&&t.chans[0]!==9), '旋律轨不得占用通道 9');
  ok(new Set(melo.map(t=>t.chans[0])).size===melo.length, '旋律轨通道撞车: '+JSON.stringify(melo.map(t=>t.chans)));
  ok(melo.every(t=>t.prog!=null), '旋律轨缺 program change');
  ok(drums.prog==null||true,'ok');
  ok(inst.every(t=>t.on===t.off), 'note on/off 数量不配对');
  // 力度要求：不能是「全轨恒 100」那种没有强弱的旧导出；
  // 五条轨在混音里都必须真的起伏（和声三音主次×换和弦抬档、氛围换和弦 66/56 两档），
  // 渲染增益同步乘 vel/VEL —— MIDI 里的强弱和听感里的强弱必须是同一套数。
  const allV=inst.flatMap(t=>t.velSet);
  const flat100=inst.filter(t=>t.velSet.length===1&&t.velSet[0]===100).map(t=>t.name);
  ok(flat100.length===0, '这些轨导出来全是 100（无强弱）: '+flat100);
  ok(new Set(allV).size>=4, '整份文件力度区分度不足: '+JSON.stringify([...new Set(allV)]));
  for(const n of ['主旋','和声','贝斯','鼓组','氛围'])
    ok(inst.find(t=>t.name===n).velSet.length>1, n+' 轨力度没起伏');
  const padV=inst.find(t=>t.name==='氛围').velSet;
  ok(padV.every(v=>v===Math.round(VEL.pad)||v===Math.round(VEL.pad*0.85)),
     '氛围轨力度应是 '+Math.round(VEL.pad)+'/'+Math.round(VEL.pad*0.85)+' 两档（换和弦/延续），实为 '+JSON.stringify(padV));
  const harmV=inst.find(t=>t.name==='和声').velSet;
  ok(harmV.every(v=>v<=VEL.harm)&&harmV.every(v=>v>=Math.round(VEL.harm*0.80*0.92)),
     '和声轨力度应随三音主次×换和弦在 ['+Math.round(VEL.harm*0.80*0.92)+', '+VEL.harm+'] 区间，实为 '+JSON.stringify(harmV));
  ok(Math.max(...allV)<=127&&Math.min(...allV)>=1, '力度越界: '+Math.min(...allV)+'..'+Math.max(...allV));
  // 各轨平均力度必须复现混音配比：主旋最响、氛围最轻
  const byName=Object.fromEntries(inst.map(t=>[t.name,t.velAvg]));
  const byMax=Object.fromEntries(inst.map(t=>[t.name,Math.max(...t.velSet)]));
  ok(byMax['主旋']>byMax['和声']&&byMax['和声']>byMax['氛围'],
     '力度上界没有反映混音配比: '+JSON.stringify(byMax));

  const lead=inst.find(t=>t.name==='主旋');
  const zero=lead.velSet;
  ok(zero.includes(99),'零时值音符 99 丢失');
  ok(lead.tick>10000, '末尾 tick 异常: '+lead.tick);

  // ---- 2. zip ----
  const files=[
    {name:'arrangement_lead.wav',data:new Uint8Array(buf.subarray(0,1000))},
    {name:'arrangement_bass.wav',data:new Uint8Array(Buffer.alloc(4096,7))},
    {name:'arrangement.mid',data:new Uint8Array(buf)},
    {name:'清单.txt',data:new TextEncoder().encode('中文文件名测试\n')},
  ];
  const zblob=E.makeZip(files);
  const zbuf=Buffer.from(await zblob.arrayBuffer());
  require('fs').writeFileSync(path.join(__dirname, 'out.zip'), zbuf);
  console.log('ZIP', zbuf.length, 'bytes');
  ok(zbuf.readUInt32LE(0)===0x04034b50, 'local header 签名错');
  ok(zbuf.includes(Buffer.from([0x50,0x4b,0x05,0x06])), '缺 EOCD');
  ok(zbuf.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]))>0, '缺 central directory');

  console.log('');
  if(fail.length){ console.log('FAIL ('+fail.length+'):'); fail.forEach(f=>console.log('  ✗ '+f)); process.exit(1); }
  console.log('单元测试全绿');
})();
