#!/usr/bin/env node
/* ============================================================
   调式结构护栏 · guard-mode-structure.js
   ------------------------------------------------------------
   合成五种五声调式的加法合成 fixture → 走 analyze 同款 chroma
   管线（hann4096/hop2048 → frameSpectrum → chromaFromSpectrum
   → detectMode/detectTonality）→ 与地面真值对拍。

   断言分两部：
     A. 五种调式 · 普通谐波（1,2,3 次，2 次 < 基频）
        —— 必须全绿：调式、主音、大调/小调标注都对。
     B. 【刻意留红】宫调式 · 3 次谐波主导（3 次 0.9 > 2 次 0.4）
        —— 期望检出宫，实测恒为徵（2026-10-05 实测 conf 0.58）。
        机制：C 的 3 次谐波 785Hz≈G5、G4 的 3 次谐波 1176Hz≈D6
        都落在 chroma 带（55–4200Hz）内，把 G 的色度权重推过 C
        （0.217 > 0.170），调性中心从 C 滑到 G，宫 → 徵。
        这是**选择保留的已知失败**：不是 bug 不修；引擎、门位、
        fixture 任何一边都不许为了让它变绿而动。要改先问用户。

   退出码：
     0 = A 全绿 且 B 如预期红（一切按预期）
     1 = 意外：A 有失败，或 B 意外变绿（引擎行为变了，需人工确认）
   ============================================================ */
'use strict';

const path = require('path');
require(path.join(__dirname, '..', 'engine.js'));
const E = globalThis.SonicEngine;
const I = E._internals;

const SR = 44100;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/* ---------- fixture 合成 ---------- */
// 以 C 为宫的五声集合 {C,D,E,G,A}，主音开场/收尾/高频次制造调性中心
const STEPS = [0, 2, 4, 7, 9];
// 调式 → 取音下标顺序（羽=从第 4 级起：A C D E G）
const ORDERS = {
  gong: [0, 1, 2, 3, 4],
  shang: [1, 2, 3, 4, 0],
  jue: [2, 3, 4, 0, 1],
  zhi: [3, 4, 0, 1, 2],
  yu: [4, 0, 1, 2, 3],
};

function melodyMidis(order, baseMidi = 60) {
  const scale = order.map((i) => baseMidi + STEPS[i]);
  const seq = [];
  // 主音 8 次打头 + 穿插 + 收尾，其余轮转
  seq.push(scale[0], scale[0], scale[2], scale[1], scale[0], scale[3], scale[4], scale[0]);
  for (let i = 0; i < 8; i++) seq.push(scale[i % 5], scale[(i + 2) % 5]);
  seq.push(scale[0], scale[0]);
  return seq;
}

// 加法合成：harmonics = [[倍频, 幅度], ...]，指数衰减包络
function synth(midis, baseSec, harmonics) {
  const total = Math.ceil(midis.length * baseSec * SR);
  const out = new Float32Array(total);
  midis.forEach((m, ni) => {
    const f = mtof(m);
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

// analyze 同款色度管线
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
  if (n > 0) for (let i = 0; i < 12; i++) acc[i] /= n;
  return acc;
}

function detectFixture(order, harmonics, baseMidi = 60) {
  const pcm = synth(melodyMidis(order, baseMidi), 0.45, harmonics);
  const chroma = chromaOf(pcm);
  const mode = I.detectMode(chroma);
  const ton = mode.root === '—'
    ? { name: null, confidence: 0 }
    : I.detectTonality(chroma, mode.rootIndex);
  return { mode, ton };
}

/* ---------- 断言收集 ---------- */
const rows = [];
const check = (part, name, ok, detail) => {
  rows.push({ part, name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/* ============================================================
   A. 五种调式 · 普通谐波（必须全绿）
   ============================================================ */
console.log('A. 五种五声调式 · 普通谐波 (1×, 2×0.5, 3×0.33)');
const H_BASIC = [[1, 1], [2, 0.5], [3, 0.33]];
// 大调/小调的地面真值（相对 C 宫集合的调式色彩，实测标定于 2026-10-05）
const TON_TRUTH = { gong: '大调', shang: '大调', jue: '小调', zhi: '大调', yu: '小调' };
const ROOT_TRUTH = { gong: 'C', shang: 'D', jue: 'E', zhi: 'G', yu: 'A' };

for (const id of Object.keys(ORDERS)) {
  const { mode, ton } = detectFixture(ORDERS[id], H_BASIC);
  check('A', `${id} · 调式`, mode.mode.id === id,
    `期望 ${id}，实测 ${mode.mode.id}（conf ${mode.confidence}）`);
  check('A', `${id} · 主音`, mode.root === ROOT_TRUTH[id],
    `期望 ${ROOT_TRUTH[id]}，实测 ${mode.root}`);
  // 大调/小调标注：名字必须给出且方向正确；置信度不作门（商/角本身偏弱）
  check('A', `${id} · 大小调`, ton.name === TON_TRUTH[id],
    `期望 ${TON_TRUTH[id]}，实测 ${ton.name}（conf ${ton.confidence}）`);
}

/* ============================================================
   B. 【刻意留红】宫 · 3 次谐波主导 —— G4/1176Hz 落带机制
   ============================================================ */
console.log('\nB. 宫 · 3 次谐波主导（已知红项 · 刻意保留）');
const H_GONG_RED = [[1, 1], [2, 0.4], [3, 0.9]];
{
  const { mode } = detectFixture(ORDERS.gong, H_GONG_RED);
  const ok = mode.mode.id === 'gong';
  check('B', 'gong-harmonic · 调式', ok,
    `期望 gong，实测 ${mode.mode.id}（conf ${mode.confidence}）`);
  if (ok) {
    console.log(
      '\n⚠ 已知红项意外变绿：gong-harmonic 现在检出 gong。\n' +
      '  引擎或 fixture 行为已变，需人工确认后再更新本护栏——不许静默通过。'
    );
  } else {
    console.log(
      '\n[KNOWN-RED · 刻意保留] C 的 3 次谐波 785Hz≈G5、G4 的 3 次谐波 1176Hz≈D6\n' +
      '  落在 chroma 带 55–4200Hz 内，把 G 权重推过 C（0.217 > 0.170），\n' +
      '  调性中心 C→G，宫被读成徵。修法（谐波剥离/重心去谐）需用户拍板，不在此脚本动。'
    );
  }
}

/* ---------- 汇总 ---------- */
const partA = rows.filter((r) => r.part === 'A');
const partB = rows.filter((r) => r.part === 'B');
const aFail = partA.filter((r) => !r.ok);
const bFail = partB.filter((r) => !r.ok);

console.log('\n========== 汇总 ==========');
console.log(`A（五调式 × 调式/主音/大小调）: ${partA.length - aFail.length}/${partA.length} 绿`);
console.log(`B（已知红 · 刻意保留）        : ${partB.length - bFail.length}/${partB.length} 绿，${bFail.length} 红`);

const allA = aFail.length === 0;
const redAsExpected = bFail.length === partB.length && partB.length > 0;
if (allA && redAsExpected) {
  console.log('结果：一切按预期 —— A 全绿，B 保持已知红。');
  process.exit(0);
}
if (allA && !redAsExpected) {
  console.log('结果：B 意外变绿 —— 引擎行为变了，人工确认后更新护栏预期。');
  process.exit(1);
}
console.log('结果：A 出现失败 —— 五声结构回归，必须修。');
process.exit(1);
