require('/Users/chenhuidediannao/Desktop/技术类作品/音智新媒项目/webapp/engine.js');
const E = globalThis.SonicEngine;
const I = E._internals;
const SR = 44100;

// 五声音阶（以 C 为宫）：C D E G A
const SET = { C:0, D:2, E:4, G:7, A:9 };
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

// 旋律：主音开场+收尾+高频次，其余音级轮转（构造调性中心）
function melody(rootDeg, modeDegOrder, baseMidi) {
  // modeDegOrder: 起点在五声中的下标，按调式顺序取（如羽=4 → A C D E G）
  const steps = [0,2,4,7,9];
  const scale = modeDegOrder.map(i => baseMidi + steps[i]);
  // 24 音符：主音 8 次打头收中，其余轮转
  const seq = [];
  seq.push(scale[0], scale[0], scale[2], scale[1], scale[0], scale[3], scale[4], scale[0]);
  for (let i = 0; i < 8; i++) seq.push(scale[i % 5], scale[(i+2) % 5]);
  seq.push(scale[0], scale[0]);
  return { seq, scale };
}

// 加法合成：基频 + 谐波；harmonics 数组是 [倍频, 幅度]
function synth(notes, baseSec, harmonics) {
  const total = Math.ceil(notes.length * baseSec * SR);
  const out = new Float32Array(total);
  notes.forEach((f, ni) => {
    const start = Math.floor(ni * baseSec * SR);
    const dur = Math.floor(baseSec * 0.92 * SR);
    for (let i = 0; i < dur; i++) {
      const t = i / SR;
      const env = Math.min(1, i / (0.01 * SR)) * Math.exp(-t * 2.2);
      let v = 0;
      for (const [k, a] of harmonics) v += a * Math.sin(2 * Math.PI * f * k * t);
      out[start + i] += v * env * 0.22;
    }
  });
  return out;
}

function chromaOf(pcm) {
  const size = 4096, hop = 2048;
  const win = I.hann(size);
  const acc = new Float64Array(12);
  let n = 0;
  for (let off = 0; off + size < pcm.length; off += hop) {
    const mag = I.frameSpectrum(pcm, off, size, win);
    const c = I.chromaFromSpectrum(mag, SR, size);
    for (let i = 0; i < 12; i++) acc[i] += c[i];
    n++;
  }
  for (let i = 0; i < 12; i++) acc[i] /= n;
  return acc;
}

const ORDERS = {
  gong: [0,1,2,3,4], // C D E G A 从宫起
  shang: [1,2,3,4,0], // D E G A C
  jue:   [2,3,4,0,1],
  zhi:   [3,4,0,1,2],
  yu:    [4,0,1,2,3],
};

function runCase(name, order, harmonics, baseMidi=60, baseSec=0.45) {
  const { seq } = melody(0, order, baseMidi);
  const freqs = seq.map(m => mtof(m));
  const pcm = synth(freqs, baseSec, harmonics);
  const chroma = chromaOf(pcm);
  const mode = I.detectMode(chroma);
  const ton = I.detectTonality(chroma, mode.rootIndex);
  const chStr = Array.from(chroma).map(x=>x.toFixed(3)).join(' ');
  console.log(`${name}: mode=${mode.mode.glyph}${mode.mode.name} root=${mode.root} conf=${mode.confidence} pentaFit=${mode.pentaFit} ton=${ton.name}(${ton.confidence})`);
  console.log(`  chroma: ${chStr}`);
  return mode;
}

const H_BASIC = [[1,1],[2,0.5],[3,0.33]];
const H_ODD   = [[1,1],[3,0.6],[5,0.3]];   // 奇谐 —— G4 的3次谐波 1176Hz 更突出
const H_G4    = [[1,1],[2,0.4],[3,0.9]];   // 3次谐波比2次还响

console.log('== 基础谐波 (1,2,3) ==');
for (const k of Object.keys(ORDERS)) runCase(k, ORDERS[k], H_BASIC);
console.log('== 奇谐突出 (1,3,5) ==');
for (const k of Object.keys(ORDERS)) runCase(k, ORDERS[k], H_ODD);
console.log('== 3次谐波主导 (1,2,3强) ==');
for (const k of Object.keys(ORDERS)) runCase('gong', ORDERS.gong, H_G4);
