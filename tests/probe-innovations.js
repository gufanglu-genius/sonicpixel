/* 第一梯队创新 · 引擎侧探针（纯 Node，秒级）
   覆盖：① 证据链字段 ② BS.1770 响度已知值 ③ 响度对齐 + 峰值守卫
        ④ 五调式互转恒等/集合闭合/偏音直通
   退出码 0=全绿 / 1=有失败 */
const path = require('path');
require(path.join(__dirname, '..', 'engine.js'));
const E = globalThis.SonicEngine;

let pass = 0, fail = 0;
const ok = (c, n, d) => { c ? (pass++, console.log(`  ✓ ${n} — ${d}`)) : (fail++, console.log(`  ✗ ${n} — ${d}`)); };

/* ---- 工具：任意采样率的假 AudioBuffer（Node 没有 AudioBuffer） ---- */
function fakeBuffer(chans, sr, fill) {
  const len = Math.round(sr * 1.0);
  const data = [];
  for (let c = 0; c < chans; c++) {
    const f = new Float32Array(len);
    for (let i = 0; i < len; i++) f[i] = fill(i, c);
    data.push(f);
  }
  return { sampleRate: sr, numberOfChannels: chans, length: len, duration: len / sr, getChannelData: (c) => data[c] };
}

/* ① 证据链字段 ------------------------------------------------ */
console.log('① 证据链字段');
{
  const I = E._internals;
  // BPM：997? 不对，用方波节拍感强的信号——这里直接跑真值合成太重，
  // 退而求其次：给一段带脉冲的信号验证 evidence 结构存在即可。
  const sr = 22050;
  const beat = fakeBuffer(1, sr, (i) => {
    const t = i / sr;
    const pulse = Math.exp(-((t * 4) % 1) * 18); // 每 0.25s 一个衰减脉冲 → 240BPM 的一半 120?
    return pulse * Math.sin(2 * Math.PI * 220 * t);
  });
  const b = I.estimateBPM(beat.getChannelData(0), sr);
  ok(!!b.evidence && Array.isArray(b.evidence.peaks) && b.evidence.peaks.length > 0,
    'estimateBPM 带 evidence.peaks', `bpm=${b.bpm} peaks=${b.evidence && b.evidence.peaks.length}`);
  ok(typeof b.evidence.dominance === 'number' && typeof b.evidence.ioiScore === 'number',
    'evidence 带置信度分量', JSON.stringify({ d: b.evidence.dominance, f: b.evidence.famScore }));

  // 拍号：真 4/4 强弱——构造「重-轻-轻-轻」包络
  const fps = 100, beats = 64;
  const env = [];
  for (let i = 0; i < beats * fps / 4; i++) {  // fps 是每拍的帧？直接按拍构造
    env.push(0);
  }
  // 简单做法：每 4 拍一个形状，用 beatLag=25 帧 (bpm=144? 用传参 bpm)
  const beatFps = 40;             // 40 帧/秒
  const bpm = 120;                // beatLag = 40*60/120 = 20 帧
  const nB = 48;
  const env2 = new Float64Array(nB * 20 + 40);
  for (let k = 0; k < nB; k++) {
    const shape = [1.0, 0.35, 0.5, 0.35][k % 4];   // 4/4 重弱次弱
    for (let j = 0; j < 18; j++) env2[k * 20 + 5 + j] = shape * Math.exp(-j / 9);
  }
  const m = I.estimateMeter(env2, beatFps, bpm);
  ok(m.meter === '4/4', 'estimateMeter 识别 4/4', `meter=${m.meter} conf=${m.confidence} reason=${m.reason}`);
  ok(m.reason === null && m.info && m.info.gates && m.info.gates.r2 === 0.24,
    '成功路径带 reason=null 与门位 info', JSON.stringify(m.info));

  // 白噪包络 → 必须留空且交代原因
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const noise = new Float64Array(4000);
  for (let i = 0; i < noise.length; i++) noise[i] = rnd() - 0.5;
  const mw = I.estimateMeter(noise, beatFps, bpm);
  ok(mw.meter === null && typeof mw.reason === 'string', '白噪留空带 reason', `reason=${mw.reason} info=${JSON.stringify(mw.info)}`);

  // 调式/大小调
  const chroma = new Array(12).fill(0);
  // C 羽（A 小调五声视角：集合 C 羽 = A C D E G → gongIndex=9(C), degIndex=4(A)
  [0, 3, 5, 7, 10].forEach((pc) => { chroma[pc] = 1; });
  const mode = I.detectMode(chroma);
  ok(typeof mode.nEff === 'number' && typeof mode.relMargin === 'number' && Array.isArray(mode.degScores),
    'detectMode 带 nEff/relMargin/degScores', `nEff=${mode.nEff} relMargin=${mode.relMargin} deg=${mode.degScores.length}`);
  const ton = I.detectTonality(chroma, mode.rootIndex);
  ok(typeof ton.majScore === 'number' && typeof ton.minScore === 'number' && typeof ton.margin === 'number',
    'detectTonality 带 majScore/minScore/margin', `maj=${ton.majScore} min=${ton.minScore}`);
}

/* ② BS.1770 已知值 ------------------------------------------------ */
console.log('② BS.1770 响度（997Hz 正弦 · 绝对值 + 线性 + 双声道求和）');
{
  // K 加权在 997Hz 的增益：用 BS.1770 标定参数的 RBJ 频响解析求，
  // 与引擎实现同设计参数（测的不是公式本身，是滤波/门限/积分整条链）。
  const rbjDb = (b0, b1, b2, a1, a2, w) => {
    const cr = Math.cos(w), ci = -Math.sin(w);
    const cr2 = Math.cos(2 * w), ci2 = -Math.sin(2 * w);
    const nr = b0 + b1 * cr + b2 * cr2, ni = b1 * ci + b2 * ci2;
    const dr = 1 + a1 * cr + a2 * cr2, di = a1 * ci + a2 * ci2;
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  };
  const shelfDbAt = (sr, f) => {
    const f0 = 1681.9748408, G = 3.999843, Q = 0.70717524;
    const A = Math.pow(10, G / 40), w0 = (2 * Math.PI * f0) / sr;
    const alpha = Math.sin(w0) / (2 * Q), cosw = Math.cos(w0), sqA = Math.sqrt(A);
    const b0 = A * ((A + 1) + (A - 1) * cosw + 2 * sqA * alpha);
    const b1 = -2 * A * ((A - 1) + (A + 1) * cosw);
    const b2 = A * ((A + 1) + (A - 1) * cosw - 2 * sqA * alpha);
    const a0 = (A + 1) - (A - 1) * cosw + 2 * sqA * alpha;
    const a1 = 2 * ((A - 1) - (A + 1) * cosw);
    const a2 = (A + 1) - (A - 1) * cosw - 2 * sqA * alpha;
    return rbjDb(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0, (2 * Math.PI * f) / sr);
  };
  const hpDbAt = (sr, f) => {
    const f0 = 38.13547087, Q = 0.50032704;
    const w0 = (2 * Math.PI * f0) / sr, alpha = Math.sin(w0) / (2 * Q), cosw = Math.cos(w0);
    const b0 = (1 + cosw) / 2, b1 = -(1 + cosw), b2 = (1 + cosw) / 2;
    const a0 = 1 + alpha, a1 = -2 * cosw, a2 = 1 - alpha;
    return rbjDb(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0, (2 * Math.PI * f) / sr);
  };

  const sr = 48000;
  const A = 0.5; // −6.02 dBFS 峰值
  const sine = (amp) => fakeBuffer(1, sr, (i) => amp * Math.sin((2 * Math.PI * 997 * i) / sr));
  const r = E.measureLoudness(sine(A));
  // 单音正弦均方 = A²/2；LUFS = −0.691 + 10log10(ms·10^(K/10))
  const kDb = shelfDbAt(sr, 997) + hpDbAt(sr, 997);
  const expect = -0.691 + 10 * Math.log10((A * A) / 2) + kDb;
  ok(r.lufs != null && Math.abs(r.lufs - expect) < 0.3,
    `正弦响度 ≈ ${expect.toFixed(1)} LUFS（K@997=${kDb.toFixed(2)}dB）`,
    `实测 ${r.lufs}（blocks=${r.blocks}, gate=${r.gate}）`);
  ok(Math.abs(r.peakDb - 20 * Math.log10(A)) < 0.05, '峰值 ≈ −6.0 dBFS', `${r.peakDb}`);

  // 线性：幅度减半 → 恰好 −6.02 LUFS
  const rHalf = E.measureLoudness(sine(A / 2));
  ok(rHalf.lufs != null && Math.abs((rHalf.lufs - r.lufs) - (-6.02)) < 0.15,
    '幅度减半 → −6.02 LUFS（线性）', `Δ=${(rHalf.lufs - r.lufs).toFixed(2)}`);

  // 双声道同信号：两路能量求和 → +3.01 LUFS（G=1/路）
  const st = fakeBuffer(2, sr, (i) => A * Math.sin((2 * Math.PI * 997 * i) / sr));
  const rSt = E.measureLoudness(st);
  ok(rSt.lufs != null && Math.abs((rSt.lufs - r.lufs) - 3.01) < 0.15,
    '双声道同信号 → +3.01 LUFS', `Δ=${(rSt.lufs - r.lufs).toFixed(2)}`);

  // 静音 → lufs null（不编数字）
  const mute = fakeBuffer(1, sr, () => 0);
  const rm = E.measureLoudness(mute);
  ok(rm.lufs === null, '静音返回 lufs=null', String(rm.lufs));

  // 1s 太短 → null
  const short = { sampleRate: sr, numberOfChannels: 1, length: sr / 4, duration: 0.25,
    getChannelData: () => new Float32Array(sr / 4) };
  ok(E.measureLoudness(short).lufs === null, '不足 400ms 返回 null', 'ok');
}

/* ③ matchLoudness 对齐 + 峰值守卫 ------------------------------------------------ */
console.log('③ 响度对齐');
{
  const sr = 48000;
  const A = 0.1;
  const buf = fakeBuffer(1, sr, (i) => A * Math.sin((2 * Math.PI * 440 * i) / sr));
  const r = E.matchLoudness(buf, -14, -1);
  ok(r.after.lufs != null && Math.abs(r.after.lufs - (-14)) < 0.6 && !r.limited,
    '对齐到 −14 LUFS 未触顶', `gain=${r.gain}dB after=${r.after.lufs} limited=${r.limited}`);

  // 峰值已经 −0.2dBFS，目标 +6dB 会被峰值线截断
  const hot = fakeBuffer(1, sr, (i) => 0.79 * Math.sin((2 * Math.PI * 440 * i) / sr));
  const r2 = E.matchLoudness(hot, 6, -1);
  ok(r2.limited === true && r2.after.peakDb <= -1 + 0.05,
    '抬升被 −1dBFS 峰值线截断（如实上报）', `gain=${r2.gain} peak=${r2.after.peakDb} limited=${r2.limited}`);
}

/* ④ 五调式互转 ------------------------------------------------ */
console.log('④ 五调式互转');
{
  // 宫音 pc9(A) 的五声集合 = {A,B,C#,E,F#} = {9,11,1,4,6}（A 宫系统）
  // 素材：集合内 {69=A4,71=B4,73=C#5,76=E5,78=F#5} + 集合外 {74(pc2),70(pc10)}
  const gong = 9;
  const deg = 4;               // 主音在集合第 4 级（pc9=A，A 为「主音」——具体名号不参与映射正确性）
  const mel = {
    contour: [69, 71, 73, 76, 78, 69, 74, 70],
    rhythm: [3, 3, 3, 3, 3, 3, 3, 3],
    noteCount: 8,
  };
  const same = E.transposeMelodyToMode(mel, gong, deg, deg);
  ok(JSON.stringify(same.contour) === JSON.stringify(mel.contour), '目标=源 时逐音恒等',
    same.contour.join(','));

  const toGong = E.transposeMelodyToMode(mel, gong, deg, 0);
  ok(toGong.contour.length === mel.contour.length, '长度不变', String(toGong.contour.length));
  ok(toGong.contour[6] === 74 && toGong.contour[7] === 70, '集合外偏音（74/70）原样直通',
    `pos6=${toGong.contour[6]} pos7=${toGong.contour[7]}`);
  const set = [0, 2, 4, 7, 9].map((s) => (gong + s) % 12);
  const inSet = toGong.contour.slice(0, 6).every((m) => set.includes(((m % 12) + 12) % 12));
  ok(inSet, '集合内 6 音映射后仍在同一五声集合', `set=${set.join('/')} out=${toGong.contour.slice(0, 6).join(',')}`);

  // 换主音必须真的换音（且只挪 ± 五声集合内的近邻，音区不跳八度以外）
  const moved = toGong.contour.slice(0, 6).some((v, i) => v !== mel.contour[i]);
  const octaveKept = toGong.contour.slice(0, 6).every((v, i) => Math.abs(v - mel.contour[i]) <= 6);
  ok(moved, 'targetDeg=0 时确有换音', toGong.contour.slice(0, 6).join(','));
  ok(octaveKept, '换音后音区保持（≤ 半八度）', toGong.contour.slice(0, 6).join(','));

  // 五目标全试一轮：每个目标都应集合闭合
  let allClose = true;
  for (let t = 0; t < 5; t++) {
    const r = E.transposeMelodyToMode(mel, gong, deg, t);
    if (!r.contour.slice(0, 6).every((m) => set.includes(((m % 12) + 12) % 12))) allClose = false;
  }
  ok(allClose, '宫商角徵羽 5 个目标全部集合闭合', 't=0..4');

  ok(E.transposeMelodyToMode(null, 0, 0, 0) === null, '空旋律返回 null', 'ok');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
