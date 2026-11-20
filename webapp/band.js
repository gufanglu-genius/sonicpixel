/* ============================================================
   初团 · 乐队编曲内核
   ------------------------------------------------------------
   与音智新媒的关系：SonicEngine（js/engine.js，原样复制）负责
   音频分析与五声调式体系；本文件是新增的编曲内核：把用户的
   旋律（哼唱/点按/示范）编成五轨乐队，支持轨道级独立重生成。

   设计铁律：
   纯函数：compose 同输入同输出，确定性随机按轨分种子；
   轨道隔离在结构上成立，每轨只从共享上下文生成，互不读取，
   重生成鼓组时旋律轨事件 deepEqual 不变，这是可测的承诺。
   整数栅格：所有事件挂在 1/16 拍上（buildScore 同一量纲），
   渲染时按 bpm 换算秒，节拍对齐是构造性的，不靠后处理。
   离线分轨：渲染用 OfflineAudioContext 每轨一个 AudioBuffer；
   混音、独奏、静音交给播放层做增益。
   ============================================================ */
(function (global) {
  'use strict';

  const S = global.SonicEngine;
  if (!S) throw new Error('band.js 需要先加载 engine.js（SonicEngine）');

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const unitSecOf = (bpm) => 60 / bpm / 4;          // 1 个栅格单位 = 1/16 拍

  /* ---------- 确定性随机：按轨分种子 ---------- */
  function hashStr(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function rngOf(seed, trackId) {
    let s = (hashStr(String(seed) + ':' + trackId) >>> 0) || 1;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /* ---------- 调式工具 ---------- */
  const MODES = S.MODES;
  function scaleOf(rootMidi, modeIndex) {
    const degrees = MODES[((modeIndex % MODES.length) + MODES.length) % MODES.length].degrees;
    return degrees.map((d) => rootMidi + d);
  }
  /* 把任意 MIDI 音吸到最近的调式内音（同八度优先，跨八度取更近侧） */
  function snapToScale(midi, scale) {
    let best = null, bestD = Infinity;
    for (let oct = -12; oct <= 12; oct += 12) {
      for (const s of scale) {
        const cand = s + oct;
        const d = Math.abs(cand - midi);
        if (d < bestD) { bestD = d; best = cand; }
      }
    }
    return best == null ? Math.round(midi) : best;
  }
  /* 调式内第 deg 级（deg 可越界取模），落在贴近 base 的八度 */
  function scaleNote(scale, deg, base) {
    const n = scale.length;
    const k = ((deg % n) + n) % n;
    const oct = Math.floor(deg / n);
    const raw = scale[k] + oct * 12;
    // 平移八度贴近 base 音区
    let m = raw;
    while (m - base >= 12) m -= 12;
    while (base - m >= 12) m += 12;
    return m;
  }

  /* ---------- 风格资产表 ---------- */
  /* prog = A 段走向；progB = B 段走向（16 小节起后半换走向，不是单旋律循环铺满） */
  const STYLES = {
    pop: {
      label: '流行',
      prog: [0, 0, 3, 4, 0, 0, 4, 3],
      progB: [3, 4, 5, 4, 3, 4, 4, 0],   // IV V vi V IV V V I，抬升感
      harm: 'chord',          // 拍点和弦
      bass: 'root5',
      drums: 'studio',
      leadInst: 'epiano',     // 钟琴长衰减会把旋律糊成一片，只配点缀；主旋换电钢
      harmInst: 'keys',
      bassInst: 'finger',
      padInst: 'warm',
    },
    ballad: {
      label: '抒情',
      prog: [0, 2, 4, 2, 0, 2, 3, 4],
      progB: [3, 3, 4, 4, 3, 2, 3, 0],   // IV IV V V IV iii IV I
      harm: 'sustain',
      bass: 'whole',
      drums: 'brush',
      leadInst: 'flute',
      harmInst: 'strings',
      bassInst: 'sub',
      padInst: 'warm',
    },
    guofeng: {
      label: '国风',
      prog: [0, 3, 0, 4, 0, 3, 4, 0],
      progB: [4, 0, 3, 0, 4, 0, 3, 4],   // V I IV I V I IV V，回环换头
      harm: 'arp',
      bass: 'sparse',
      drums: 'wood',
      leadInst: 'pluck',
      harmInst: 'pluck',
      bassInst: 'sub',
      padInst: 'glass',
    },
    groove: {
      label: '律动',
      prog: [0, 4, 0, 3, 0, 4, 2, 3],
      progB: [3, 0, 3, 4, 3, 0, 2, 4],   // I 与 IV 换位，挂到 V 收
      harm: 'stab',
      bass: 'octave',
      drums: 'funk',
      leadInst: 'flute',
      harmInst: 'keys',
      bassInst: 'finger',
      padInst: 'glass',
    },
  };

  const PERSONAS = [
    { id: 'lead',  name: '阿旋', role: '主旋', hint: '你的旋律由他守护' },
    { id: 'harm',  name: '小满', role: '和声', hint: '给旋律铺台阶' },
    { id: 'bass',  name: '老周', role: '贝斯', hint: '低频的地基' },
    { id: 'drums', name: '咚咚', role: '鼓组', hint: '整首歌的心跳' },
    { id: 'pad',   name: '云朵', role: '氛围', hint: '空气感制造机' },
  ];

  const TRACK_ORDER = ['lead', 'harm', 'bass', 'drums', 'pad'];

  /* ---------- 批次8：单轨织体与疏密 ----------
     texture 只解绑风格表锁死的模式（和声/贝斯/鼓组三轨有织体维度，
     主旋是用户旋律、氛围只有两层，都不设）；模型侧存稀疏表，只记
     用户显式指定过的轨，未指定的继续走 STYLES 缺省，因此不带该
     字段的 compose 与旧版逐字节一致。
     density 是单轨疏密：鼓与贝斯叠在全局强度上（缺省偏移为零），
     和声与氛围直接换音符槽位（0.5 中性 = 旧行为）。 */
  const TEXTURE_OPTS = {
    harm: ['chord', 'sustain', 'arp', 'stab'],
    bass: ['whole', 'sparse', 'octave', 'root5'],
    drums: ['studio', 'brush', 'wood', 'funk'],
  };
  const DENSITY_TRACKS = ['harm', 'bass', 'drums', 'pad'];

  function sanitizeTexture(t) {
    const out = {};
    if (!t || typeof t !== 'object') return out;
    for (const k of Object.keys(TEXTURE_OPTS)) {
      if (TEXTURE_OPTS[k].includes(t[k])) out[k] = t[k];
    }
    return out;
  }

  function sanitizeDensity(d) {
    const out = {};
    if (!d || typeof d !== 'object') return out;
    for (const k of DENSITY_TRACKS) {
      const v = d[k];
      if (Number.isFinite(v) && v >= 0 && v <= 1) out[k] = v;
    }
    return out;
  }

  /* 三档：低于 0.375 稀、高于 0.625 密，中间是旧行为（中性 0.5）。
     口语一档台阶 0.18 正好跨过一条边界，「密一点」听得出变化。 */
  function densTier(v) {
    const d = Number.isFinite(v) ? v : 0.5;
    return d < 0.375 ? 'low' : d > 0.625 ? 'high' : 'mid';
  }

  /* ============================================================
     旋律输入规范化
     items: [{k:'n', midi, start, dur} | {k:'r', start, dur}]，栅格单位
     ============================================================ */
  function prepMelody(items, opts) {
    const o = opts || {};
    const scale = o.scale;
    const gridPerBar = o.gridPerBar || 16;
    const minBars = o.minBars || 4;
    const notes = (items || []).filter((it) => it && it.k === 'n' && it.dur > 0);
    if (!notes.length) return { items: [], bars: minBars, registerShift: 0 };

    // 吸附到调式内（诊断卡选「原样保留」时 snap=false，跑调照实呈现）
    const snapped = o.snap === false
      ? notes.map((n) => ({ k: 'n', midi: Math.round(n.midi), start: n.start, dur: n.dur }))
      : notes.map((n) => ({ k: 'n', midi: snapToScale(n.midi, scale), start: n.start, dur: n.dur }));

    /* 八度纠错：真歌 scoreEvents 是复音主导音高轨迹不是旋律转写，
       相邻音常整段跳八度（实测 480 次 ≥12 半音），只吸附音级治不了，
       主旋会听成乱哔的合成音。两步：①折到全曲中位数 ±12 窗口；
       ②时间序上仍 >12 半音的残余朝前音收一档。恰为 12 的跳进保留
       （可能是有意的八度上行），常用音区夹在 36..96。 */
    const foldOctaves = (seq) => {
      if (seq.length < 2) return seq;
      const pitchSorted = seq.map((n) => n.midi).sort((a, b) => a - b);
      const med = pitchSorted[Math.floor(pitchSorted.length / 2)];
      const out = seq.map((n) => {
        let m = n.midi;
        while (m - med > 12) m -= 12;
        while (med - m > 12) m += 12;
        return { ...n, midi: m };
      });
      for (let i = 1; i < out.length; i++) {
        let m = out[i].midi;
        const prev = out[i - 1].midi;
        let guard = 0;
        while (Math.abs(m - prev) > 12 && guard++ < 4) {
          const next = m + (m > prev ? -12 : 12);
          if (next < 36 || next > 96) break;
          m = next;
        }
        if (m !== out[i].midi) out[i] = { ...out[i], midi: m };
      }
      return out;
    };
    const folded = foldOctaves(snapped);

    // 音区归一：只抬真正偏低的哼唱（中位数不足 56），目标约 G4；
    // 原本在中声区的旋律（含示范动机）保持原样，抬高八度进高音区只会发尖
    const sorted = folded.map((n) => n.midi).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    let shift = 0;
    if (median < 56) {
      shift = clamp(Math.round((67 - median) / 12) * 12, 0, 24);   // 整八度，最多两档
      const top = sorted[sorted.length - 1];
      while (shift > 0 && top + shift > 84) shift -= 12;           // 抬后封顶 84
    }
    const lifted = shift ? folded.map((n) => ({ ...n, midi: n.midi + shift })) : folded;

    const end = Math.max(...lifted.map((n) => n.start + n.dur));
    const melBars = Math.max(1, Math.ceil(end / gridPerBar));
    let bars = Math.max(minBars, melBars);         // 至少到下限档；末小节留作收束
    if (Number.isFinite(o.maxBars)) bars = Math.min(bars, o.maxBars);   // 上限 96：超长旋律截断，事件循环里同步裁齐

    // 旋律不足则原样循环铺满（去掉收束小节）
    const loopSpan = melBars * gridPerBar;
    const out = [];
    for (let b = 0; b < bars; b++) {
      for (const n of lifted) {
        const t = n.start + b * loopSpan;
        if (t >= bars * gridPerBar) continue;
        out.push({ k: 'n', midi: n.midi, start: t, dur: Math.min(n.dur, bars * gridPerBar - t) });
      }
    }
    // 同栅格重叠：后音为王，压短前音（与 setMelody 同语义）。
    // 旧实现推后音起点，长音会把后面的音推走最多半拍，节奏直接变形
    out.sort((a, b) => a.start - b.start || a.midi - b.midi);
    const clean = [];
    for (const n of out) {
      const prev = clean[clean.length - 1];
      if (prev && n.start < prev.start + prev.dur) prev.dur = n.start - prev.start;
      if (prev && prev.dur <= 0) clean.pop();
      clean.push(n);
    }
    return { items: clean, bars, registerShift: shift };
  }

  /* ============================================================
     各轨生成：每轨一个纯函数，共享 ctx，互不读对方
     ctx = { melody, scale, prog, style, styleId, seed, intensity,
             gridPerBar, bars, meter, bpm, rootMidi, modeIndex,
             instruments, trackIntensity }
     ============================================================ */

  function composeLead(ctx) {
    const { melody, gridPerBar, bars, seed, styleId } = ctx;
    const rnd = rngOf(seed, 'lead');
    const inst = ctx.instruments.lead;
    const out = [];
    const lastBar = bars - 1;                     // 收束小节：旋律停，留呼吸

    for (const n of melody) {
      if (n.start >= lastBar * gridPerBar) continue;
      const dur = Math.min(n.dur, lastBar * gridPerBar - n.start);
      if (dur <= 0) continue;
      const posInBar = n.start % gridPerBar;
      // 小节首音与长音给足力度，碎音收一点，人声哼唱的自然起伏
      let vel = posInBar === 0 ? 108 : dur >= 8 ? 96 : 84;
      vel += Math.round((rnd() - 0.5) * 8);
      // 国风主旋偶发装饰音：十六分后缀。目标必须吸回调式内音，
      // 半音直加会出调（角音 +2 半音是升发），和声正铺时非常扎耳
      if (styleId === 'guofeng' && dur >= 6 && rnd() < 0.18) {
        const up = rnd() < 0.5;
        let cand = snapToScale(n.midi + (up ? 2 : -2), ctx.scale);
        if (cand === n.midi) cand = snapToScale(n.midi + (up ? -2 : 2), ctx.scale);
        if (cand !== n.midi) out.push({ t: n.start + dur - 1, dur: 1, midi: cand, vel: Math.max(40, vel - 22), inst });
      }
      out.push({ t: n.start, dur, midi: n.midi, vel: clamp(vel, 30, 120), inst });
    }
    // 收束小节：落回主音长音，贴着旋律自己的音区（写死 72 会和旋律脱节）
    if (out.length) {
      const last = out[out.length - 1];
      const tonic = scaleNote(ctx.scale, 0, last.midi);
      out.push({ t: lastBar * gridPerBar, dur: gridPerBar, midi: tonic, vel: 70, inst });
    }
    return out;
  }

  function chordDegs(prog, bar) { return prog[bar % prog.length]; }

  /* 两段式：16 小节起前半 A 段走向、后半 B 段走向；不足 16 小节维持单段循环。
     每个小节的和声级数在编曲之初一次定死（progMap），五轨共享同一张地图。 */
  function buildProgMap(style, bars) {
    const A = style.prog;
    const B = style.progB || A;
    const map = [];
    const half = bars >> 1;
    for (let bar = 0; bar < bars; bar++) {
      if (bars < 16) map.push(A[bar % A.length]);
      else if (bar < half) map.push(A[bar % A.length]);
      else map.push(B[(bar - half) % B.length]);
    }
    return map;
  }

  /* 旋律拟合地图：风格走向只给先验，每个小节的级数由旋律自己的
     音级时值权重在调式内候选三和弦里选出（和弦音覆盖最多者胜，
     风格原值 +0.08 先验，平局保持曲式身份）。和声/贝斯/氛围共享
     这张地图，哼什么配什么，而不是拿固定走向盖在任意旋律上。
     纯函数：compose 与 recomposeTrack 用同一输入算出同一张图，
     轨道隔离的 deepEqual 承诺不受影响。 */
  function fitProgMap(melody, scale, gridPerBar, bars, style) {
    const base = buildProgMap(style, bars);
    if (!melody || !melody.length) return base;
    const n = scale.length;
    const map = [];
    for (let bar = 0; bar < bars; bar++) {
      const t0 = bar * gridPerBar;
      const t1 = t0 + gridPerBar;
      // 该小节旋律音按重叠时值加权的音级分布
      const w = new Map();
      let total = 0;
      for (const nt of melody) {
        const s = Math.max(nt.start, t0);
        const e = Math.min(nt.start + nt.dur, t1);
        const dur = e - s;
        if (dur <= 0) continue;
        const pc = ((nt.midi % 12) + 12) % 12;
        w.set(pc, (w.get(pc) || 0) + dur);
        total += dur;
      }
      if (!total) { map.push(base[bar]); continue; }
      let best = base[bar];
      let bestScore = -Infinity;
      for (let d = 0; d < n; d++) {
        const tones = new Set([d, d + 2, d + 4].map((x) =>
          ((scale[((x % n) + n) % n] % 12) + 12) % 12));
        let hit = 0;
        for (const [pc, ww] of w) if (tones.has(pc)) hit += ww;
        let score = hit / total;
        if (d === base[bar]) score += 0.08;         // 风格走向先验
        if (score > bestScore) { bestScore = score; best = d; }
      }
      map.push(best);
    }
    return map;
  }

  function composeHarm(ctx) {
    const { progMap, gridPerBar, bars, styleId, seed, instruments, tex } = ctx;
    const rnd = rngOf(seed, 'harm');
    const mode = (tex && tex.harm) || STYLES[styleId].harm;
    const tier = densTier(ctx.density && ctx.density.harm);   // 缺省 0.5 = 中档 = 旧行为
    const inst = instruments.harm;
    const out = [];
    const base = 58;                               // 和声声部基准音区
    for (let bar = 0; bar < bars - 1; bar++) {
      const d = progMap[bar];
      const notes = [d, d + 2, d + 4].map((x) => scaleNote(ctx.scale, x, base));
      if (mode === 'sustain') {
        // 稀只留根音；中三音铺满一小节（旧行为）；密半小节再击一次
        const vs = tier === 'low' ? notes.slice(0, 1) : notes;
        if (tier === 'high') {
          const half = Math.floor(gridPerBar / 2);
          vs.forEach((m, i) => out.push({ t: bar * gridPerBar, dur: half - 1, midi: m, vel: 56 - i * 6, inst }));
          vs.forEach((m, i) => out.push({ t: bar * gridPerBar + half, dur: gridPerBar - half - 1, midi: m, vel: 50 - i * 6, inst }));
        } else {
          vs.forEach((m, i) => out.push({ t: bar * gridPerBar, dur: gridPerBar - 1, midi: m, vel: 56 - i * 6, inst }));
        }
      } else if (mode === 'arp') {
        // 古筝式琶音：八分上行再回落；密档补满十六分、稀档只留四分骨架
        const slots = tier === 'low' ? [0, 4, 8].filter((s) => s < gridPerBar)
          : tier === 'high' ? [0, 2, 4, 6, 8, 10, 12, 14].filter((s) => s < gridPerBar)
          : [0, 2, 4, 6, 8, 10];
        slots.forEach((s, i) => {
          const m = notes[i % 3] + (i >= 3 ? 12 : 0);
          // 中档保持旧值 3；高低档夹到小节内，尾拍不跨小节
          const dur = tier === 'mid' ? 3 : Math.min(3, gridPerBar - s - 1);
          out.push({ t: bar * gridPerBar + s, dur, midi: m, vel: 66 + (i === 0 ? 14 : 0) + Math.round(rnd() * 6), inst });
        });
      } else if (mode === 'stab') {
        // 稀只留首拍；中 [0,6,10]（旧行为）；密在第二拍前插一记
        const slots = tier === 'low' ? [0] : tier === 'high' ? [0, 4, 6, 10] : [0, 6, 10];
        slots.forEach((s, i) => {
          notes.forEach((m) => out.push({
            t: bar * gridPerBar + s, dur: i === 1 ? 2 : 3, midi: m,
            vel: clamp((i === 0 ? 74 : 58) + Math.round(rnd() * 8 - 4), 30, 120), inst,
          }));
        });
      } else {                                    // chord：拍点柱式
        // 中档 [0, 半小节] 与旧式逐字节等价（dur = 半小节 - 2）；
        // 密档四击、稀档只留强拍，dur 由到下一槽的间距推出
        const slots = tier === 'low' ? [0]
          : tier === 'high' ? [0, gridPerBar >> 2, gridPerBar >> 1, (gridPerBar >> 1) + (gridPerBar >> 2)]
          : [0, Math.floor(gridPerBar / 2)];
        slots.forEach((s, i) => {
          const nextS = i + 1 < slots.length ? slots[i + 1] : gridPerBar;
          const dur = Math.max(1, nextS - s - 2);
          notes.forEach((m, k) => out.push({
            t: bar * gridPerBar + s, dur,
            midi: m, vel: clamp((i === 0 ? 72 : 58) - k * 5 + Math.round(rnd() * 8 - 4), 30, 120), inst,
          }));
        });
      }
    }
    return out;
  }

  function composeBass(ctx) {
    const { progMap, gridPerBar, bars, styleId, seed, instruments, intensity } = ctx;
    const rnd = rngOf(seed, 'bass');
    const mode = (ctx.tex && ctx.tex.bass) || STYLES[styleId].bass;
    // 单轨疏密叠在全局强度上：缺省无偏移，行为与旧版逐字节一致
    const den = ctx.density && ctx.density.bass;
    const eff = Number.isFinite(den) ? clamp(intensity + den - 0.5, 0, 1) : intensity;
    const inst = instruments.bass;
    const out = [];
    const base = 36;                               // 贝斯音区
    const mid = Math.floor(gridPerBar / 2);
    for (let bar = 0; bar < bars - 1; bar++) {
      const root = scaleNote(ctx.scale, progMap[bar], base);
      const t0 = bar * gridPerBar;
      if (mode === 'whole') {
        out.push({ t: t0, dur: gridPerBar - 1, midi: root, vel: 82, inst });
      } else if (mode === 'sparse') {
        out.push({ t: t0, dur: Math.floor(gridPerBar * 0.6), midi: root, vel: 80, inst });
        if (eff >= 0.5) out.push({ t: t0 + mid, dur: 4, midi: root + 12, vel: 58, inst });
      } else if (mode === 'octave') {
        for (let s = 0; s < gridPerBar; s += 4) {
          const oct = (s / 4) % 2 === 1 ? 12 : 0;
          out.push({ t: t0 + s, dur: 3, midi: root + oct, vel: s === 0 ? 96 : 74, inst });
        }
        if (eff >= 0.6) out.push({ t: t0 + gridPerBar - 2, dur: 2, midi: root + 7, vel: 66, inst });
      } else {                                    // root5
        out.push({ t: t0, dur: Math.floor(gridPerBar / 2) - 1, midi: root, vel: 92, inst });
        out.push({ t: t0 + mid, dur: Math.floor(gridPerBar / 2) - 1, midi: root + 7 > 55 ? root : root + 7, vel: 80, inst });
        if (eff >= 0.65) {
          // 十六分幽灵音，力度压半
          out.push({ t: t0 + mid + 2, dur: 1, midi: root, vel: 44 + Math.round(rnd() * 8), inst });
        }
      }
    }
    // 收束：主音长音压底
    const tonic = scaleNote(ctx.scale, 0, base);
    out.push({ t: (bars - 1) * gridPerBar, dur: gridPerBar - 1, midi: tonic, vel: 76, inst });
    return out;
  }

  function composeDrums(ctx) {
    const { gridPerBar, bars, styleId, seed, intensity, sectionAt } = ctx;
    const rnd = rngOf(seed, 'drums');
    const kit = (ctx.tex && ctx.tex.drums) || STYLES[styleId].drums;
    // 单轨疏密叠在全局强度上：缺省无偏移，行为与旧版逐字节一致
    const den = ctx.density && ctx.density.drums;
    const eff = Number.isFinite(den) ? clamp(intensity + den - 0.5, 0, 1) : intensity;
    const out = [];
    const push = (t, drum, vel, dur) => out.push({ t, dur: dur || 1, drum, vel: clamp(Math.round(vel), 20, 127) });
    const mid = Math.floor(gridPerBar / 2);
    const lastBar = bars - 1;

    for (let bar = 0; bar < bars; bar++) {
      const t0 = bar * gridPerBar;
      const isLast = bar === lastBar;

      if (kit === 'wood') {
        // 国风：强拍木鱼、次强轻点、收束小节只留一记
        if (isLast) { push(t0, 'wood', 96, 2); break; }
        push(t0, 'wood', 104, 2);
        if (gridPerBar >= 12) push(t0 + mid, 'wood', 72, 1);
        if (eff >= 0.45) push(t0 + Math.floor(gridPerBar / 4), 'hat', 40, 1);
        if (eff >= 0.7) push(t0 + gridPerBar - 2, 'hat', 52, 1);
        if (bar === 0) push(t0, 'crash', 70, 4);
        continue;
      }

      if (kit === 'brush') {
        // 抒情：软底鼓 + 帽，几乎无军鼓
        push(t0, 'kick', 78, 2);
        for (let s = 0; s < gridPerBar; s += 2) push(t0 + s, 'hat', s === 0 ? 46 : 30, 1);
        if (eff >= 0.55 && !isLast) push(t0 + mid, 'snare', 44, 1);
        if (isLast) push(t0, 'crash', 52, 4);
        continue;
      }

      if (kit === 'funk') {
        if (isLast) {
          // 过门：十六分军鼓渐强
          for (let s = 0; s < 8; s++) push(t0 + gridPerBar - 8 + s, 'snare', 52 + s * 7, 1);
          push(t0, 'kick', 88, 2);
          break;
        }
        push(t0, 'kick', 104, 2);
        push(t0 + mid, 'snare', 96, 2);
        if (gridPerBar >= 8) push(t0 + mid + 6 > t0 + gridPerBar - 1 ? t0 + gridPerBar - 2 : t0 + 6, 'kick', 70, 1);
        for (let s = 0; s < gridPerBar; s += 2) push(t0 + s, 'hat', s % 4 === 0 ? 58 : 42, 1);
        if (eff >= 0.55) push(t0 + gridPerBar - 2, 'hat', 50, 1);
        if (eff >= 0.75) push(t0 + mid + 1, 'hat', 48, 1);
        if (bar === 0) push(t0, 'crash', 66, 4);
        continue;
      }

      // studio（流行）：重拍底鼓、反拍军鼓、帽子按强度升密
      if (isLast) {
        if (eff >= 0.5) {
          for (let s = 0; s < 4; s++) push(t0 + gridPerBar - 4 + s, 'snare', 56 + s * 8, 1);
        }
        push(t0, 'crash', 64, 4);
        break;
      }
      push(t0, 'kick', 106, 2);
      push(t0 + mid, 'snare', 98, 2);
      if (eff >= 0.6) push(t0 + mid + 4, 'kick', 74, 1);
      const hatStep = eff >= 0.75 ? 1 : eff >= 0.4 ? 2 : 4;
      for (let s = 0; s < gridPerBar; s += hatStep) {
        push(t0 + s, 'hat', s === 0 ? 60 : (s % 4 === 0 ? 48 : 36), 1);
      }
      if (bar === 0) push(t0, 'crash', 68, 4);
      if (eff >= 0.85 && rnd() < 0.5) push(t0 + gridPerBar - 1, 'openhat', 44, 2);
    }
    // B 段起手标记：镲一记（国风换重木鱼，不抢民乐质感），接缝听得见也看得见
    if (sectionAt > 0) {
      const t0 = sectionAt * gridPerBar;
      if (t0 < lastBar * gridPerBar) {
        if (kit === 'wood') push(t0, 'wood', 112, 2);
        else push(t0, 'crash', 66, 4);
      }
    }
    return out;
  }

  function composePad(ctx) {
    const { progMap, gridPerBar, bars, styleId, seed, instruments } = ctx;
    const rnd = rngOf(seed, 'pad');
    const inst = instruments.pad;
    const tier = densTier(ctx.density && ctx.density.pad);   // 缺省 0.5 = 中档 = 旧行为
    const out = [];
    const base = 70;
    for (let bar = 0; bar < bars; bar++) {
      const d = progMap[bar];
      const root = scaleNote(ctx.scale, d, base);
      const fifth = scaleNote(ctx.scale, d + 2, base + 4);
      const isLast = bar === bars - 1;
      const vel = bar === 0 || d !== progMap[bar - 1] ? 54 : 44;
      out.push({ t: bar * gridPerBar, dur: gridPerBar - 1, midi: root, vel: vel + Math.round(rnd() * 4), inst });
      if (tier !== 'low') out.push({ t: bar * gridPerBar, dur: gridPerBar - 1, midi: fifth, vel: Math.max(28, vel - 12), inst });
      if (tier === 'high') out.push({ t: bar * gridPerBar, dur: gridPerBar - 1, midi: root + 12, vel: Math.max(24, vel - 20), inst });
    }
    return out;
  }

  const COMPOSERS = { lead: composeLead, harm: composeHarm, bass: composeBass, drums: composeDrums, pad: composePad };

  /* ============================================================
     compose：整首编曲（纯函数）
     ============================================================ */
  function compose(input) {
    const inp = input || {};
    const styleId = STYLES[inp.style] ? inp.style : 'pop';
    const style = STYLES[styleId];
    const bpm = clamp(Math.round(inp.bpm || 92), 40, 200);
    const meter = inp.meter || '4/4';
    const rootMidi = Number.isFinite(inp.rootMidi) ? inp.rootMidi : 60;
    const modeIndex = Number.isFinite(inp.modeIndex) ? inp.modeIndex : 0;
    const seed = Number.isFinite(inp.seed) ? inp.seed : 7;
    const intensity = clamp(Number.isFinite(inp.intensity) ? inp.intensity : 0.55, 0, 1);
    const gridPerBar = meter === '3/4' || meter === '6/8' ? 12 : meter === '2/4' ? 8 : 16;
    const scale = scaleOf(rootMidi, modeIndex);

    const snap = inp.snap !== false;
    // 长度档位：显式指定时钉死在该值（短则循环铺满、长则截断）；
    // 缺省十六小节起步，旋律更长则顺势展开，硬顶 96 小节。
    const hasTarget = Number.isFinite(inp.bars);
    const targetBars = clamp(Math.round(inp.bars || 16), 4, 96);
    const prep = prepMelody(inp.melodyItems || [], {
      scale, gridPerBar,
      minBars: hasTarget ? targetBars : 16,
      maxBars: hasTarget ? targetBars : 96,
      snap,
    });
    const bars = clamp(prep.bars, 4, 96);

    const instruments = Object.assign({
      lead: style.leadInst, harm: style.harmInst, bass: style.bassInst,
      pad: style.padInst, drums: 'kit',
    }, inp.instruments || {});

    // 织体：稀疏存显式指定，缺省走风格；ctx 里给作曲用的生效值
    const texture = sanitizeTexture(inp.texture);
    const density = sanitizeDensity(inp.density);
    const tex = {
      harm: texture.harm || style.harm,
      bass: texture.bass || style.bass,
      drums: texture.drums || style.drums,
    };

    // 和声走向贴旋律选级数（见 fitProgMap），不是固定盖章
    const progMap = fitProgMap(prep.items, scale, gridPerBar, bars, style);

    const ctx = {
      melody: prep.items, scale, prog: style.prog, styleId, seed, intensity,
      gridPerBar, bars, meter, bpm, rootMidi, modeIndex, instruments,
      progMap, tex, density,
      sectionAt: bars >= 16 ? bars >> 1 : -1,
    };

    const tracks = {};
    for (const id of TRACK_ORDER) tracks[id] = COMPOSERS[id](ctx);

    return {
      version: 1,
      bpm, meter, style: styleId, seed, intensity, snap,
      rootMidi, modeIndex, scale, gridPerBar, bars,
      units: bars * gridPerBar,
      melodyItems: prep.items,
      progMap,
      registerShift: prep.registerShift,
      instruments: Object.assign({}, instruments),
      texture: Object.assign({}, texture),
      density: Object.assign({}, density),
      muted: Object.assign({}, inp.muted || {}),
      tracks,
    };
  }

  /* ============================================================
     recomposeTrack：轨道级重生成，只重算指定轨
     其余轨保持对象引用原样返回，deepEqual 由构造保证。
     ============================================================ */
  function recomposeTrack(model, trackId, patch) {
    if (!model || !model.tracks || !COMPOSERS[trackId]) return model;
    const p = patch || {};
    const next = {
      ...model,
      instruments: { ...model.instruments },
      tracks: { ...model.tracks },
      muted: { ...model.muted },
    };
    if (p.intensity != null) next.intensity = clamp(p.intensity, 0, 1);
    if (p.bpm != null) next.bpm = clamp(Math.round(p.bpm), 40, 200);
    if (p.instrument) next.instruments[trackId] = p.instrument;
    if (p.mute != null) next.muted[trackId] = !!p.mute;
    if (p.seed != null) next.seed = p.seed;
    // 织体与疏密：只记在有该维度的轨上（schema 是第一道门，这里是兜底）
    if (p.texture != null && TEXTURE_OPTS[trackId]) {
      next.texture = Object.assign({}, model.texture || {});
      next.texture[trackId] = p.texture;
    }
    if (p.density != null && DENSITY_TRACKS.includes(trackId)) {
      next.density = Object.assign({}, model.density || {});
      next.density[trackId] = clamp(p.density, 0, 1);
    }

    const styleId = next.style;
    const style = STYLES[styleId];
    const texSparse = next.texture || {};
    const ctx = {
      melody: model.melodyItems, scale: model.scale, prog: style.prog, styleId,
      seed: next.seed, intensity: next.intensity, gridPerBar: model.gridPerBar,
      bars: model.bars, meter: model.meter, bpm: next.bpm,
      rootMidi: model.rootMidi, modeIndex: model.modeIndex,
      instruments: next.instruments,
      // 生效织体 = 显式指定优先，其余走风格缺省；疏密原样透传
      tex: {
        harm: texSparse.harm || style.harm,
        bass: texSparse.bass || style.bass,
        drums: texSparse.drums || style.drums,
      },
      density: sanitizeDensity(next.density),
      // 与 compose 同一张旋律拟合地图：旧模型缺字段时用同输入重算
      progMap: model.progMap || fitProgMap(model.melodyItems, model.scale, model.gridPerBar, model.bars, style),
      sectionAt: model.bars >= 16 ? model.bars >> 1 : -1,
    };
    next.tracks[trackId] = COMPOSERS[trackId](ctx);
    return next;
  }

  /* ============================================================
     setMelody：卷帘编辑管线，用户改过的 lead 以编辑结果为准，
     只重算 lead 自己；其余四轨不读 melody，保持对象引用原样，
     deepEqual 由构造保证。音高不重跑音区归一（用户点哪算哪），
     重叠语义与 prepMelody 相反：后音为王，压短前音（画布上
     新加的音必须看得见，不能被推让吞掉）。
     ============================================================ */
  function setMelody(model, items) {
    if (!model || !model.tracks) return model;
    const gpb = model.gridPerBar;
    const units = model.units;
    const scale = model.scale;
    const snap = model.snap !== false;
    // 音区归一抬升过的音不在 scale 原表的候选带里，再吸一次会被降级
    // （如抬到 84 的会被拉回 81）。吸附候选并上抬升带，保证幂等。
    const shift = Number.isFinite(model.registerShift) ? model.registerShift : 0;
    const snapScale = shift ? scale.concat(scale.map((s) => s + shift)) : scale;

    const notes = (items || [])
      .filter((n) => n && n.dur > 0 && (n.k === 'n' || n.k == null))
      .map((n) => ({
        k: 'n',
        midi: snap ? snapToScale(Math.round(n.midi), snapScale) : Math.round(n.midi),
        start: Math.max(0, Math.round(n.start)),
        dur: Math.max(1, Math.round(n.dur)),
      }))
      .filter((n) => n.start < units)
      .map((n) => ({ ...n, dur: Math.min(n.dur, units - n.start) }));
    notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
    const clean = [];
    for (const n of notes) {
      const prev = clean[clean.length - 1];
      if (prev && n.start < prev.start + prev.dur) prev.dur = n.start - prev.start;
      if (prev && prev.dur <= 0) clean.pop();
      clean.push(n);
    }

    const next = { ...model, melodyItems: clean, tracks: { ...model.tracks } };
    const styleId = STYLES[next.style] ? next.style : 'pop';
    const style = STYLES[styleId];
    const ctx = {
      melody: clean, scale, prog: style.prog, styleId,
      seed: next.seed, intensity: next.intensity, gridPerBar: gpb,
      bars: next.bars, meter: next.meter, bpm: next.bpm,
      rootMidi: next.rootMidi, modeIndex: next.modeIndex,
      instruments: next.instruments,
      // setMelody 只重算 lead（lead 不读 progMap），沿用原图保持隔离承诺
      progMap: next.progMap || buildProgMap(style, next.bars),
      sectionAt: next.bars >= 16 ? next.bars >> 1 : -1,
    };
    next.tracks.lead = composeLead(ctx);
    return next;
  }

  /* ============================================================
     渲染：每轨一个 OfflineAudioContext → AudioBuffer
     ============================================================ */
  const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  /* ---------- Karplus-Strong 拨弦（纯 JS 采样级物理建模，node 可单测） ----------
     噪声激发进 N=round(sr/f) 长的延迟环，环内一阶平均低通加损耗因子。
     t60 直接映射损耗：loss = exp(-6.9078/(sr·t60))，返回归一化 Float32Array。 */
  function ksSamples(freq, durSec, sr, rnd, opts) {
    const o = opts || {};
    const f = clamp(freq, 40, 4000);
    const N = Math.max(2, Math.round(sr / f));
    const t60 = o.t60 || 2.2;
    const loss = Math.exp(-6.9078 / (sr * t60));
    const tail = o.tail != null ? o.tail : 0.5;
    const len = Math.max(N, Math.ceil((durSec + tail) * sr));
    const bright = o.bright != null ? o.bright : 0.8;
    const alpha = 0.12 + 0.88 * bright;               // 激发预低通：0 暗 → 1 白噪
    const line = new Float32Array(N);
    let lp = 0;
    for (let i = 0; i < N; i++) {
      const n = rnd() * 2 - 1;
      lp += (n - lp) * alpha;
      line[i] = lp;
    }
    const out = new Float32Array(len);
    const a = o.damp != null ? o.damp : 0.45;         // 环内平均低通系数
    let prev = line[N - 1];
    let idx = 0, peak = 0;
    for (let i = 0; i < len; i++) {
      const y = line[idx];
      out[i] = y;
      if (Math.abs(y) > peak) peak = Math.abs(y);
      const filt = (1 - a) * y + a * prev;
      prev = y;
      line[idx] = filt * loss;
      idx = (idx + 1) % N;
    }
    const norm = peak > 1e-6 ? 1 / peak : 1;
    const fin = Math.min(48, len), fout = Math.min(256, len);
    for (let i = 0; i < len; i++) {
      let v = out[i] * norm;
      if (i < fin) v *= i / fin;
      if (i >= len - fout) v *= (len - i) / fout;
      out[i] = v;
    }
    return out;
  }

  /* ---------- 共享噪声缓冲：管乐气息层 / 弓噪用 ---------- */
  function noiseBuffer(ctx, sec, rnd) {
    const len = Math.max(1, Math.ceil(ctx.sampleRate * sec));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = rnd() * 2 - 1;
    return buf;
  }

  /* ---------- 律动与人体工学（渲染时叠加，事件保持整数栅格） ----------
     五轨共享同一张 swing 表：全乐队一起摇，而不是各摇各的。
     逐音微抖动按轨分寸，鼓最窄（节拍器），氛围最松。
     swing 定义为奇数 8 分位推迟的秒数 = ratio × 4 拍格（一拍的几分之几）。 */
  const SWING = { pop: 0.06, ballad: 0.05, guofeng: 0.03, groove: 0.16 };
  const HUM_MS = { lead: 4, harm: 5, bass: 3, drums: 1.5, pad: 6 };
  // 感知起音提前量：慢起音乐器提前落键，让「听得见的那一下」踩回拍点。
  // 栅格分数是下限（快拍也至少提前这么多）；warm 另有绝对秒下限。
  // FluidR3 暖垫起振实测约 0.31s，160BPM 时 0.6 格只有 0.056s，
  // 追不上起振，氛围整段拖在鼓后面像各走各的拍。绝对秒只加在
  // 长音氛围上并夹到半音长内，不碰 strings/glass（批次6 栅格化
  // 是为了防快拍整格错位，那两类仍走纯栅格）。
  // 应用点在 renderTrack（合成与采样渲染共用），scheduleVoice 不再自行提前。
  const ATTACK_ADV = { strings: 0.35, warm: 0.6, glass: 0.45 };
  const ATTACK_ADV_SEC = { warm: 0.10 };

  function humanizeSec(model, trackId, e, unit) {
    const swing = SWING[model.style] || 0.05;
    const grid = model.gridPerBar;
    const pos = ((e.t % grid) + grid) % grid;
    let off = 0;
    if (pos % 4 === 2) off += swing * 4 * unit;       // 奇数 8 分：swing 主体
    if (pos % 2 === 1) off += swing * 0.8 * unit;     // 十六分后半：再拖一点
    const jitterMs = (HUM_MS[trackId] || 3) + swing * 20;
    const rnd = rngOf(model.seed, 'hum:' + trackId + ':' + e.t + ':' + (e.drum != null ? e.drum : e.midi));
    // 小节首是锚点，抖动压到四分之一，整队跟着它走
    const amt = (jitterMs / 1000) * (pos === 0 ? 0.25 : 1);
    off += (rnd() - 0.5) * 2 * amt;
    return off;
  }

  /* 颤音 LFO：延迟起振（真人揉弦不从第一个音符就开揉） */
  function addVibrato(ctx, osc, t, stopT, freq, depth, rate, delay) {
    const vib = ctx.createOscillator();
    vib.frequency.value = rate || 5.2;
    const amt = ctx.createGain();
    amt.gain.setValueAtTime(0, t);
    amt.gain.linearRampToValueAtTime(freq * depth, t + (delay || 0.18));
    vib.connect(amt); amt.connect(osc.frequency);
    vib.start(t); vib.stop(stopT);
  }

  function scheduleVoice(ctx, master, inst, freq, t, dur, vel, rnd, unit) {
    const g = ctx.createGain();
    rnd = rnd || (() => 0.5);
    // 感知起音提前量已上提到 renderTrack（合成与采样共用同一条提前量）
    // 逐音力度微变：同力度连击是机械感的大头
    const peak = (vel / 127) * 0.5 * (0.94 + rnd() * 0.12);

    if (inst === 'pluck' || inst === 'harp') {
      // 物理建模拨弦：古筝亮而短，竖琴暗而长
      const harp = inst === 'harp';
      const samples = ksSamples(freq, Math.max(dur, harp ? 1.2 : 0.5), ctx.sampleRate, rnd, {
        t60: harp ? 3.6 : 2.2, bright: harp ? 0.6 : 0.85, damp: harp ? 0.55 : 0.42,
        tail: harp ? 1.2 : 0.6,
      });
      const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buf.copyToChannel(samples, 0);
      const src = ctx.createBufferSource(); src.buffer = buf;
      g.gain.value = peak * (harp ? 0.85 : 1);
      src.connect(g);
      src.start(t);
    } else if (inst === 'flute' || inst === 'bamboo') {
      // 笛/箫：正弦主体 + 二倍弱泛音 + 颤音 + 气息噪声层（箫气更重）
      const breathy = inst === 'bamboo' ? 0.15 : 0.07;
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
      const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 2;
      const g2 = ctx.createGain(); g2.gain.value = inst === 'bamboo' ? 0.05 : 0.09;
      o2.connect(g2); g2.connect(g);
      const vib = ctx.createOscillator(); vib.frequency.value = 5.4;
      const vibAmt = ctx.createGain(); vibAmt.gain.setValueAtTime(0, t);
      vibAmt.gain.linearRampToValueAtTime(freq * 0.007, t + 0.18);
      vib.connect(vibAmt); vibAmt.connect(o.frequency);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.05);
      g.gain.setValueAtTime(peak, t + Math.max(0.05, dur - 0.06));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
      o.connect(g);
      o.start(t); o.stop(t + dur + 0.1);
      o2.start(t); o2.stop(t + dur + 0.1);
      vib.start(t); vib.stop(t + dur + 0.1);
      // 气息层：带通噪声随音量包络走
      const nb = noiseBuffer(ctx, Math.min(2.5, dur + 0.2), rnd);
      const ns = ctx.createBufferSource(); ns.buffer = nb;
      const nf = ctx.createBiquadFilter(); nf.type = 'bandpass';
      nf.frequency.value = Math.min(8000, freq * 2.4); nf.Q.value = 0.7;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.linearRampToValueAtTime(peak * breathy, t + 0.05);
      ng.gain.setValueAtTime(peak * breathy, t + Math.max(0.05, dur - 0.08));
      ng.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
      ns.connect(nf); nf.connect(ng); ng.connect(master);
      ns.start(t); ns.stop(t + dur + 0.1);
    } else if (inst === 'bell') {
      // 每口钟的失谐与衰减都略有出入：完全同参的钟琴就是「电子玩具」的来源。
      // 衰减跟随时值加短尾，不再一律 0.7 秒起步：十六分音符一个接一个时，
      // 长尾叠非谐分音就是一锅糊响
      [[1, 1], [2.76, 0.28], [5.4, 0.1]].forEach((p, i) => {
        const wob = 1 + (rnd() - 0.5) * 0.006;
        const decay = Math.min(Math.max(dur * 1.35, 0.45), 1.4) * (0.92 + rnd() * 0.16);
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq * p[0] * wob;
        const gg = ctx.createGain();
        gg.gain.setValueAtTime(0.0001, t);
        gg.gain.exponentialRampToValueAtTime(peak * p[1] * (i === 0 ? 1 : 0.5) * (0.92 + rnd() * 0.16), t + 0.01);
        gg.gain.exponentialRampToValueAtTime(0.0001, t + decay);
        o.connect(gg); gg.connect(master);
        o.start(t); o.stop(t + decay + 0.15);
      });
      g.connect(master);
      return;                                       // bell 自带连接，跳过统一路径
    } else if (inst === 'keys' || inst === 'epiano') {
      // FM 键盘：1:1 调制比，调制指数从高到低滑落（琴弦咬合感→稳定泛音）
      const eP = inst === 'epiano';
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
      const mod = ctx.createOscillator(); mod.type = 'sine';
      mod.frequency.value = freq * (eP ? 1 : 2);
      const idxG = ctx.createGain();
      idxG.gain.setValueAtTime(freq * (eP ? 3.0 : 2.4) * (0.9 + rnd() * 0.2), t);
      idxG.gain.exponentialRampToValueAtTime(Math.max(1, freq * 0.12), t + (eP ? 0.25 : 0.4));
      mod.connect(idxG); idxG.connect(o.frequency);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak * (eP ? 0.85 : 1), t + 0.012);
      g.gain.exponentialRampToValueAtTime(peak * (eP ? 0.3 : 0.4), t + Math.max(0.2, dur * 0.6));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + (eP ? 0.5 : 0.35));
      const f = ctx.createBiquadFilter(); f.type = 'lowpass';
      f.frequency.value = eP ? 3800 : 5200;
      o.connect(f); f.connect(g);
      if (eP) addVibrato(ctx, o, t, t + dur + 0.55, freq, 0.0018, 5.1, 0.22);
      o.start(t); o.stop(t + dur + 0.55);
      mod.start(t); mod.stop(t + dur + 0.55);
    } else if (inst === 'organ') {
      // 加法风琴：纯音簇，快起快收；电子风琴有颤音电机，给一点
      const orgs = [];
      [[1, 1], [2, 0.45], [3, 0.25], [4, 0.12], [6, 0.06]].forEach((p) => {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq * p[0];
        orgs.push(o);
        const gg = ctx.createGain();
        gg.gain.setValueAtTime(0.0001, t);
        gg.gain.linearRampToValueAtTime(peak * p[1] * 0.55, t + 0.03);
        gg.gain.setValueAtTime(peak * p[1] * 0.55, t + Math.max(0.05, dur - 0.05));
        gg.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.12);
        o.connect(gg); gg.connect(g);
        o.start(t); o.stop(t + dur + 0.15);
      });
      orgs.forEach((o) => addVibrato(ctx, o, t, t + dur + 0.15, freq, 0.0015, 5.0, 0.25));
    } else if (inst === 'strings') {
      // 三振荡微失谐锯齿过低通 + 弓噪起音层
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 0.5;
      f.frequency.setValueAtTime(1100, t);
      f.frequency.linearRampToValueAtTime(2100, t + Math.min(0.4, dur * 0.5));
      const strOscs = [];
      for (const d of [0.9965, 1, 1.0038]) {
        const os = ctx.createOscillator(); os.type = 'sawtooth'; os.frequency.value = freq * d;
        strOscs.push(os);
        const og = ctx.createGain(); og.gain.value = 0.26;
        os.connect(og); og.connect(f);
        os.start(t); os.stop(t + dur + 0.2);
      }
      // 弦乐必有揉弦，延迟起振模拟真实起音习惯
      strOscs.forEach((os) => addVibrato(ctx, os, t, t + dur + 0.2, os.frequency.value, 0.004, 5.1, 0.18));
      f.connect(g);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak * 0.8, t + Math.min(0.22, dur * 0.4));
      g.gain.setValueAtTime(peak * 0.8, t + Math.max(0.22, dur - 0.12));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.15);
      const nb = noiseBuffer(ctx, Math.min(1.2, dur + 0.2), rnd);
      const ns = ctx.createBufferSource(); ns.buffer = nb;
      const nf = ctx.createBiquadFilter(); nf.type = 'highpass'; nf.frequency.value = 1900;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.linearRampToValueAtTime(peak * 0.05, t + 0.06);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + Math.min(dur, 0.5));
      ns.connect(nf); nf.connect(ng); ng.connect(master);
      ns.start(t); ns.stop(t + Math.min(dur, 0.6) + 0.1);
    } else if (inst === 'sub') {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.02);
      g.gain.setValueAtTime(peak, t + Math.max(0.02, dur - 0.05));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.06);
      o.connect(g);
      o.start(t); o.stop(t + dur + 0.1);
    } else if (inst === 'finger') {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = freq;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass';
      f.frequency.setValueAtTime(1400, t);
      f.frequency.exponentialRampToValueAtTime(420, t + Math.min(dur, 0.3));
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(dur, 0.3));
      o.connect(f); f.connect(g);
      o.start(t); o.stop(t + dur + 0.35);
    } else if (inst === 'warm' || inst === 'glass') {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
      const osc2 = ctx.createOscillator(); osc2.type = 'sine'; osc2.frequency.value = freq * (inst === 'glass' ? 3.01 : 2.003);
      const gg2 = ctx.createGain(); gg2.gain.value = inst === 'glass' ? 0.18 : 0.3;
      const atk = inst === 'glass' ? 0.35 : 0.8;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak * 0.7, t + atk);
      g.gain.setValueAtTime(peak * 0.7, t + Math.max(atk, dur - 0.2));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.25);
      o.connect(g); osc2.connect(gg2); gg2.connect(g);
      o.start(t); o.stop(t + dur + 0.3);
      osc2.start(t); osc2.stop(t + dur + 0.3);
    } else {
      // 默认三角
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.03);
      o.connect(g);
      o.start(t); o.stop(t + dur + 0.05);
    }
    g.connect(master);
  }

  function scheduleDrum(ctx, master, drum, t, vel, rnd) {
    rnd = rnd || (() => 0.5);
    // 鼓手同样没有两下完全一样重的
    const peak = (vel / 127) * 0.55 * (0.95 + rnd() * 0.1);
    if (drum === 'kick') {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(46, t + 0.09);
      const g = ctx.createGain();
      g.gain.setValueAtTime(peak, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + 0.3);
    } else if (drum === 'snare') {
      const len = Math.floor(ctx.sampleRate * 0.14);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (rnd() * 2 - 1) * Math.pow(1 - i / len, 1.8);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.9;
      const g = ctx.createGain(); g.gain.value = peak;
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t);
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 190;
      const g2 = ctx.createGain(); g2.gain.setValueAtTime(peak * 0.5, t);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      o.connect(g2); g2.connect(master);
      o.start(t); o.stop(t + 0.1);
    } else if (drum === 'hat' || drum === 'openhat') {
      const durSec = drum === 'openhat' ? 0.16 : 0.045;
      const len = Math.floor(ctx.sampleRate * durSec);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (rnd() * 2 - 1) * Math.pow(1 - i / len, 2.2);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7200;
      // 真镲片 12kHz 以上自然滚降，白噪一路铺到奈奎斯特就是「电流声」
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 11000; lp.Q.value = 0.5;
      const g = ctx.createGain(); g.gain.value = peak * 0.6;
      src.connect(f); f.connect(lp); lp.connect(g); g.connect(master);
      src.start(t);
    } else if (drum === 'wood') {
      const len = Math.floor(ctx.sampleRate * 0.06);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (rnd() * 2 - 1) * Math.pow(1 - i / len, 3);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2300; f.Q.value = 2.4;
      const g = ctx.createGain(); g.gain.value = peak;
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t);
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 1150;
      const g2 = ctx.createGain(); g2.gain.setValueAtTime(peak * 0.4, t);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
      o.connect(g2); g2.connect(master);
      o.start(t); o.stop(t + 0.06);
    } else if (drum === 'crash') {
      const len = Math.floor(ctx.sampleRate * 1.3);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (rnd() * 2 - 1) * Math.pow(1 - i / len, 1.4);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 3800;
      // 同帽镲：限制奈奎斯特前的白噪铺展，留空气感去掉毛刺
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9500; lp.Q.value = 0.5;
      const g = ctx.createGain(); g.gain.value = peak * 0.32;
      src.connect(f); f.connect(lp); lp.connect(g); g.connect(master);
      src.start(t);
    }
  }

  const PAN = { lead: 0.12, harm: -0.28, bass: 0, drums: 0, pad: 0 };

  /* 单轨离线渲染 */
  async function renderTrack(model, trackId, opts) {
    const o = opts || {};
    const sr = o.sr || 44100;
    // 批次9：先等真实采样音源就绪（就绪/失败都 resolve，失败即全程合成）。
    // 加载失败绝不半采样混搭：同一轨要么全采样要么全合成，音色才不跳。
    const sampler = global.BandSampler;
    if (sampler && sampler.whenReady) await sampler.whenReady();
    const useSample = !!(sampler && sampler.ready && sampler.ready());
    const unit = unitSecOf(model.bpm);
    // 采样模式释音封顶 1.8 秒，尾巴留够整段余响；合成模式沿用 0.8
    const durSec = model.units * unit + (useSample ? 2.2 : 0.8);
    const len = Math.ceil(durSec * sr);
    const ctx = new OfflineAudioContext(2, len, sr);
    const master = ctx.createGain();
    master.gain.value = 0.9;
    let dest = master;
    if (PAN[trackId]) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = PAN[trackId];
      master.connect(pan); pan.connect(ctx.destination);
    } else {
      master.connect(ctx.destination);
    }
    const rnd = rngOf(model.seed, 'render:' + trackId);
    const events = model.tracks[trackId] || [];
    // 和声/氛围：同拍和弦音错开落键（真人没有同一毫秒砸下三根手指的）
    const rollSec = new Map();
    if (trackId === 'harm' || trackId === 'pad') {
      const byT = new Map();
      events.forEach((e, i) => {
        if (!byT.has(e.t)) byT.set(e.t, []);
        byT.get(e.t).push(i);
      });
      for (const [tk, idxs] of byT) {
        if (idxs.length < 2) continue;
        const rr = rngOf(model.seed, 'roll:' + trackId + ':' + tk);
        const span = 0.012 + rr() * 0.016;           // 整个和弦 12~28ms 内滚完
        const step = span / (idxs.length - 1);
        idxs.forEach((i, k) => rollSec.set(i, k * step));
      }
    }
    const ui = [];
    events.forEach((e, i) => {
      const tGrid = e.t * unit;
      const dur = Math.max(0.03, e.dur * unit);
      // 五轨共享 swing 表 + 各轨分寸的微抖动：一起摇，不是各摇各的
      let t = Math.max(0, tGrid + humanizeSec(model, trackId, e, unit) + (rollSec.get(i) || 0));
      if (trackId === 'drums') {
        const played = useSample && sampler.scheduleDrum(ctx, master, e.drum, t, e.vel, rnd);
        if (!played) scheduleDrum(ctx, master, e.drum, t, e.vel, rnd);
        ui.push({ tSec: tGrid, durSec: 0.06, drum: e.drum, vel: e.vel });
      } else {
        const inst = e.inst || 'triangle';
        // 感知起音提前量（合成/采样共用）：WebAudio 拒负数调度时间，最多吃到 0
        if (ATTACK_ADV[inst]) {
          let adv = ATTACK_ADV[inst] * unit;
          if (ATTACK_ADV_SEC[inst]) adv = Math.max(adv, ATTACK_ADV_SEC[inst]);
          adv = Math.min(adv, dur * 0.5);          // 不吞掉半音以上，长音氛围才用得上
          t = Math.max(0, t - adv);
        }
        const played = useSample &&
          sampler.scheduleVoice(ctx, master, inst, e.midi, t, dur, e.vel, rnd, unit);
        if (!played) scheduleVoice(ctx, master, inst, midiToHz(e.midi), t, dur, e.vel, rnd, unit);
        ui.push({ tSec: tGrid, durSec: dur, midi: e.midi, vel: e.vel });
      }
    });
    const buffer = await ctx.startRendering();
    return { buffer, events: ui };
  }

  /* 全轨渲染：返回 { buffers:{id:AudioBuffer}, events:{id:[...]}, duration, sampleRate } */
  async function renderStems(model, opts) {
    const o = opts || {};
    const sr = o.sr || 44100;
    const only = o.only || null;                    // 只渲染某轨（重生成热更新用）
    const ids = only ? [only] : TRACK_ORDER;
    /* 五轨互不依赖，各自独立 OfflineAudioContext；串行 await 是白付的
       墙钟时间（8 小节实测 5 轨合计 1551ms）。并行提交后取回同序结果。 */
    const rs = await Promise.all(ids.map((id) => renderTrack(model, id, { sr })));
    const buffers = {};
    const events = {};
    ids.forEach((id, i) => {
      buffers[id] = rs[i].buffer;
      events[id] = rs[i].events;
    });
    return {
      buffers, events,
      duration: model.units * unitSecOf(model.bpm),
      sampleRate: sr,
    };
  }

  /* ---------- 总线：程序化混响 + 轻压缩 + EQ 倾斜 ----------
     IR 用指数衰减噪声现场生成（免采样版权），压缩器只压尖峰，
     EQ 低架抬厚度、高架添空气。导出与实时播放共用同一条链。 */
  function makeImpulse(ctx, opts) {
    const o = opts || {};
    const sr = ctx.sampleRate;
    const dur = o.dur || 1.7;
    const len = Math.max(8, Math.floor(sr * dur));
    const buf = ctx.createBuffer(2, len, sr);
    const rnd = rngOf(o.seed != null ? o.seed : 7, 'ir');
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const env = Math.exp((-3.2 * i) / (sr * dur / 3));   // 指数衰减
        const n = rnd() * 2 - 1;
        lp += (n - lp) * 0.42;                               // 轻低通，高频衰快一点
        d[i] = lp * env * 0.5;
      }
      // 早反射点：给空间一点「房间」而不是纯糊
      for (const [ms, amp] of [[13, 0.5], [19, -0.38], [29, 0.3], [41, -0.22]]) {
        const idx = Math.floor((ms / 1000) * sr) + (ch ? 7 : 0);
        if (idx < len) d[idx] += amp * 0.4;
      }
    }
    return buf;
  }

  function makeBus(ctx, opts) {
    const o = opts || {};
    const input = ctx.createGain();
    const dry = ctx.createGain(); dry.gain.value = 1;
    const wet = ctx.createGain(); wet.gain.value = o.wet != null ? o.wet : 0.15;
    const conv = ctx.createConvolver();
    conv.buffer = makeImpulse(ctx, { seed: o.seed, dur: o.revbDur });
    const lo = ctx.createBiquadFilter(); lo.type = 'lowshelf';
    lo.frequency.value = 130; lo.gain.value = 1.6;
    const hi = ctx.createBiquadFilter(); hi.type = 'highshelf';
    hi.frequency.value = 6500; hi.gain.value = 2.0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 18; comp.ratio.value = 3;
    comp.attack.value = 0.006; comp.release.value = 0.24;
    const makeup = ctx.createGain(); makeup.gain.value = o.makeup != null ? o.makeup : 1.25;

    input.connect(dry); dry.connect(lo);
    input.connect(conv); conv.connect(wet); wet.connect(lo);
    lo.connect(hi); hi.connect(comp); comp.connect(makeup);
    return { input, output: makeup };
  }

  /* 混音：把分轨 Buffer 求和成一条（导出用）。muted 可排除轨。
     bus:false 关掉总线（新旧响度 A/B 用），默认开启。 */
  async function mixStems(buffers, opts) {
    const o = opts || {};
    const ids = TRACK_ORDER.filter((id) => buffers[id]);
    if (!ids.length) return null;
    const first = buffers[ids[0]];
    const sr = o.sr || first.sampleRate;
    const len = Math.max(...ids.map((id) => buffers[id].length));
    const extra = o.bus === false ? 0 : Math.ceil((o.revbDur || 1.7) * sr * 0.35);
    const ctx = new OfflineAudioContext(2, len + extra, sr);
    const master = ctx.createGain();
    master.gain.value = o.gain != null ? o.gain : 0.85;
    let tail = master;
    if (o.bus !== false) {
      const bus = makeBus(ctx, { seed: o.seed, wet: o.wet, makeup: o.makeup, revbDur: o.revbDur });
      master.connect(bus.input);
      tail = bus.output;
    }
    tail.connect(ctx.destination);
    for (const id of ids) {
      if (o.muted && o.muted[id]) continue;
      const g = ctx.createGain();
      g.gain.value = o.gains && o.gains[id] != null ? o.gains[id] : 1;
      const src = ctx.createBufferSource();
      src.buffer = buffers[id];
      src.connect(g); g.connect(master);
      src.start(0);
    }
    return ctx.startRendering();
  }

  /* ============================================================
     漂移感知量化：YIN 音符（秒）→ 1/16 栅格事件
     ------------------------------------------------------------
     人唱歌普遍越唱越快或越唱越慢，整段时间轴相对栅格滑动后逐音
     四舍五入必然散乱。做法：先按名义 BPM 把起音吸附到栅格，对
     残差（实际秒数减栅格秒数）做关于时间的线性回归，把时间轴
     拉正（t' = t − c − d·t）再吸附一次。限幅 ±15%，防极端跑偏。
     ============================================================ */
  /* 环形均值：把折在 ±半格里的残差当角度求平均（0 落在 ±unit 处要按圆心算） */
  function circMean(xs, unit) {
    let s = 0, c = 0;
    for (const x of xs) { s += Math.sin(2 * Math.PI * x / unit); c += Math.cos(2 * Math.PI * x / unit); }
    if (Math.abs(s) < 1e-12 && Math.abs(c) < 1e-12) return 0;
    return Math.atan2(s, c) * unit / (2 * Math.PI);
  }

  /* 漂移感知的起始时间校正：
     漂移够大时残差会绕圈（±半格），直接回归会被混叠吃掉（实测斜率会翻号）。
     这里分三步：
     1) 对每个候选斜率 d，在环形残差代价下取环形均值当截距，代价最小者为初值；
     2) 按当前线解卷绕，做普通最小二乘精修，迭代几次；
     3) 时间轴拉正 t' = t − c − d·t，再进整数栅格取整。 */
  function warpOnsets(notes, unit) {
    if (!notes || notes.length < 8) return notes;
    const n = notes.length;
    const ts = notes.map((nt) => nt.t);
    const rs = ts.map((t) => t - Math.round(t / unit) * unit);
    const D_MAX = 0.2;                                   // 覆盖 ±25% 整段漂移
    let bc = 0, bd = 0, bestCost = Infinity;
    for (let d = -D_MAX; d <= D_MAX + 1e-9; d += 0.004) {
      const xs = rs.map((r, i) => r - d * ts[i]);
      const c = circMean(xs, unit);
      let cost = 0;
      for (let i = 0; i < n; i++) { const e = xs[i] - c; const w = e - Math.round(e / unit) * unit; cost += w * w; }
      if (cost < bestCost) { bestCost = cost; bd = d; bc = c; }
    }
    let d = bd, c = bc;
    for (let pass = 0; pass < 3; pass++) {               // 解卷绕 → 最小二乘精修
      const un = rs.map((r, i) => r - Math.round((r - (c + d * ts[i])) / unit) * unit);
      let sT = 0, sR = 0, sTT = 0, sTR = 0;
      for (let i = 0; i < n; i++) { sT += ts[i]; sR += un[i]; sTT += ts[i] * ts[i]; sTR += ts[i] * un[i]; }
      const denom = n * sTT - sT * sT;
      if (Math.abs(denom) < 1e-9) break;
      d = clamp((n * sTR - sT * sR) / denom, -D_MAX, D_MAX);
      c = (sR - d * sT) / n;
    }
    if (Math.abs(d) < 1e-4 && Math.abs(c) < unit * 0.05) return notes;
    return notes.map((nt) => ({ midi: nt.midi, t: nt.t - c - d * nt.t, dur: nt.dur }));
  }

  /* 落点相位搜索：哼唱的「一」几乎不在按录音键的那一毫秒。
     栅格锚死在 t=0 会让和弦换在乐句中间，整首都是拧的。
     在 0..gridPerBar-1 里找一个相位整体平移旋律，判据是
     音符落在强拍的分量最大、小节线前起音最少；并列取最小相位。 */
  function phaseSearch(items, gridPerBar) {
    if (!items || items.length < 4) return items;
    const minStart = Math.min(...items.map((n) => n.start));
    const w = (pos) => (pos === 0 ? 5 : pos % 4 === 0 ? 3 : pos % 2 === 0 ? 1.2 : 0.4);
    let best = 0, bestScore = -Infinity, bestFirst = Infinity;
    for (let s = 0; s <= minStart && s < gridPerBar; s++) {
      let score = 0;
      for (const n of items) {
        const pos = (n.start - s) % gridPerBar;
        score += w(pos);
        if (pos === gridPerBar - 1) score -= 2;      // 挨着小节线起音：疑似相位错
      }
      // 并列时首音贴小节头者胜：全四分的乐句在任何拍点上得分相同，
      // 但用户开口的第一句就该落在小节「一」上
      const firstPos = ((minStart - s) % gridPerBar + gridPerBar) % gridPerBar;
      if (score > bestScore + 1e-9 ||
          (Math.abs(score - bestScore) <= 1e-9 && firstPos < bestFirst)) {
        bestScore = score; bestFirst = firstPos; best = s;
      }
    }
    if (!best) return items;
    return items.map((n) => ({ ...n, start: n.start - best }));
  }

  /* 量化残差（绝对秒平方均值）：同一段旋律在对的速度上残差只剩
     检测噪声，在错的速度上残差按格宽铺开，两者差着数量级。
     倍频候选（75/100/150 都能把整格点唱对）残差几乎相同，
     靠「离 92 最近」的并列裁决，躲开半速/倍速陷阱。 */
  function quantCost(notes, bpm) {
    const unit = 60 / bpm / 4;
    let c = 0;
    const ns = (notes || []).filter((nt) => nt && nt.t >= 0);
    for (const nt of ns) {
      const r = nt.t - Math.round(nt.t / unit) * unit;
      c += r * r;
    }
    return ns.length ? c / ns.length : Infinity;
  }
  /* 旋律自测速：哼唱没有打击乐，能量包络法基本靠猜。
     候选不全扫，用中位起音间隔反推（当四分/附点四分/八分各测，
     再试半速与四分速），锚在实际音符密度上；候选贫瘠时兜底全扫。
     倍频关系的候选（75/100/150）在整格点唱上残差本就几乎相同，
     单靠旋律分不出八度，用 anchor（分析器速度）做并列裁决：
     旋律自测速是对分析器的精修，不是另起炉灶。 */
  function tempoFromMelody(notes, anchor) {
    const anchorBpm = Number.isFinite(anchor) && anchor > 0 ? anchor : 92;
    const ns = (notes || []).filter((nt) => nt && nt.t >= 0).sort((a, b) => a.t - b.t);
    if (ns.length < 6) return null;
    const ios = [];
    for (let i = 1; i < ns.length; i++) {
      const d = ns[i].t - ns[i - 1].t;
      if (d > 0.05) ios.push(d);
    }
    if (!ios.length) return null;
    ios.sort((a, b) => a - b);
    const base = 60 / ios[Math.floor(ios.length / 2)];
    const cand = new Set();
    for (const m of [1, 1.5, 2]) {
      for (const div of [1, 2, 4]) {
        const b = Math.round(base * m / div);
        if (b >= 55 && b <= 160) cand.add(b);
      }
    }
    if (!cand.size) for (let b = 55; b <= 160; b++) cand.add(b);
    let best = null, bestCost = Infinity;
    for (const bpm of cand) {
      const c = quantCost(ns, bpm);
      const thr = Number.isFinite(bestCost) ? 1e-6 + bestCost * 1e-4 : Infinity;
      const tie = Math.abs(c - bestCost) <= thr;
      if (best == null || c < bestCost - thr ||
          (tie && Math.abs(bpm - anchorBpm) < Math.abs(best - anchorBpm))) {
        bestCost = c; best = bpm;
      }
    }
    return best == null ? null : { bpm: best, cost: bestCost };
  }

  function quantizeNotes(notes, opts) {
    const o = opts || {};
    const bpm = clamp(Math.round(o.bpm || 92), 40, 200);
    const meter = /^\d+\/\d+$/.test(o.meter || '') ? o.meter : '4/4';
    const num = parseInt(meter.split('/')[0], 10);
    const den = parseInt(meter.split('/')[1], 10);
    const gridPerBar = Math.round((num * 16) / den);
    const unit = 60 / bpm / 4;                           // 1 格 = 1/16 拍
    let ns = (notes || []).filter((nt) => nt && nt.dur > 0);
    if (o.warp !== false) ns = warpOnsets(ns, unit);
    let items = ns.map((nt) => {
      const start = Math.max(0, Math.round(nt.t / unit));
      const end = Math.max(start + 1, Math.round((nt.t + nt.dur) / unit));
      return { k: 'n', midi: Math.round(nt.midi), start, dur: end - start };
    });
    if (o.phase) items = phaseSearch(items, gridPerBar);
    items.sort((a, b) => a.start - b.start || a.midi - b.midi);
    // 同栅格重叠：后音为王，压短前音（绝不推后音起点）
    const clean = [];
    for (const it of items) {
      const prev = clean[clean.length - 1];
      if (prev && it.start < prev.start + prev.dur) prev.dur = it.start - prev.start;
      if (prev && prev.dur <= 0) clean.pop();
      clean.push(it);
    }
    return { items: clean, gridPerBar, bpm, meter };
  }

  /* ---------- 哼唱 → 编曲输入（YIN 轨迹优先，回落 SonicEngine 分析链） ---------- */
  function analyzeMelody(audioBuffer) {
    const profile = S.analyze(audioBuffer);
    const id = profile.identity || {};
    const meter = typeof id.meter === 'string' && /^\d+\/\d+$/.test(id.meter) ? id.meter : '4/4';
    const bpm = id.bpm > 0 ? clamp(Math.round(id.bpm), 40, 200) : 92;
    const identity = {
      bpm, meter, key: id.key, mode: id.mode, modeGlyph: id.modeGlyph,
      bpmConfidence: id.bpmConfidence, modeConfidence: id.modeConfidence,
    };
    // 旋律轨迹：YIN 时域基频（优先）；缺失时回落 engine 的频谱峰值法
    const Y = global.BandYin;
    if (Y) {
      const mono = Y.toMono(audioBuffer);
      const track = Y.pitchTrack(mono, audioBuffer.sampleRate);
      const rawNotes = Y.segment(track, audioBuffer.sampleRate);
      // 速度仲裁：能量包络对无鼓哼唱基本靠猜，旋律自测速残差明显
      // 更小（一半以下）才换用，否则维持分析器的值
      const melT = tempoFromMelody(rawNotes, identity.bpm);
      if (melT && melT.cost < 0.5 * quantCost(rawNotes, identity.bpm)) {
        identity.bpm = melT.bpm;
        identity.bpmSource = 'melody';
      } else {
        identity.bpmSource = 'envelope';
      }
      return { profile, identity, rawNotes, via: 'yin', noteCount: rawNotes.length };
    }
    const melody = profile.melody || {};
    const spf = 4096 / audioBuffer.sampleRate;
    const score = S.buildScore(melody.scoreEvents || [], {
      bpm, meter, sampleRate: audioBuffer.sampleRate, secPerFrame: spf,
    });
    return { profile, identity, score, rawNotes: null, via: 'peak', noteCount: score.noteCount };
  }

  /* ---------- 内置示范旋律（栅格事件；原创五声动机，无版权负担） ---------- */
  const DEMO = {
    // 示范动机：起承转合，落在宫音，天然五声
    spark: (() => {
      const seq = [
        [69, 4], [67, 4], [64, 4], [62, 4],
        [60, 8], [62, 4], [64, 4],
        [67, 4], [69, 4], [72, 8],
        [69, 4], [67, 4], [64, 4], [62, 4],
        [60, 12],
      ];
      const items = [];
      let t = 0;
      for (const [m, d] of seq) { items.push({ k: 'n', midi: m, start: t, dur: d }); t += d; }
      return { items, bpm: 96, meter: '4/4', rootMidi: 60, modeIndex: 0, label: '示范动机' };
    })(),
    // 小星星（传统民谣，公有领域）：吸附到五声会有民乐味
    twinkle: (() => {
      const seq = [
        [60, 4], [60, 4], [67, 4], [67, 4], [69, 4], [69, 4], [67, 8],
        [65, 4], [65, 4], [64, 4], [64, 4], [62, 4], [62, 4], [60, 8],
      ];
      const items = [];
      let t = 0;
      for (const [m, d] of seq) { items.push({ k: 'n', midi: m, start: t, dur: d }); t += d; }
      return { items, bpm: 104, meter: '4/4', rootMidi: 60, modeIndex: 0, label: '小星星' };
    })(),
  };

  /* ---------- 导出辅助 ---------- */
  function modelToEvents(model) {
    const unit = unitSecOf(model.bpm);
    const out = [];
    for (const id of TRACK_ORDER) {
      for (const e of (model.tracks[id] || [])) {
        if (id === 'drums') {
          out.push({ track: 'drums', t: e.t * unit, dur: Math.max(0.05, e.dur * unit), note: e.drum === 'kick' ? 36 : e.drum === 'snare' ? 38 : e.drum === 'hat' || e.drum === 'openhat' ? 42 : e.drum === 'crash' ? 49 : 76, vel: e.vel });
        } else {
          out.push({ track: id, t: e.t * unit, dur: e.dur * unit, note: e.midi, vel: e.vel });
        }
      }
    }
    return out;
  }

  global.Band = {
    compose, recomposeTrack, setMelody, renderStems, renderTrack, mixStems,
    analyzeMelody, prepMelody, snapToScale, scaleOf, scaleNote,
    quantizeNotes, warpOnsets, tempoFromMelody, quantCost, phaseSearch,
    makeBus, makeImpulse, ksSamples,
    modelToEvents, DEMO, STYLES, PERSONAS, TRACK_ORDER,
    unitSecOf,
    _internals: { rngOf, hashStr, composeLead, composeHarm, composeBass, composeDrums, composePad, buildProgMap, fitProgMap, humanizeSec, SWING, ATTACK_ADV },
  };
})(typeof window !== 'undefined' ? window : globalThis);
