/* ============================================================
   音智新媒 · 音频引擎
   真实的 Web Audio 分析与处理 — 不依赖任何外部数据
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 小工具 ---------- */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const dbFrom = (x) => 20 * Math.log10(Math.max(x, 1e-9));
  const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');

  /* ============================================================
     1. FFT（迭代基-2）
     ============================================================ */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
  }

  /* ============================================================
     2. 频谱 / 色度
     ============================================================ */
  function frameSpectrum(data, offset, size, window) {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      const s = offset + i;
      re[i] = s < data.length ? data[s] * window[i] : 0;
    }
    fft(re, im);
    const half = size >> 1;
    const mag = new Float64Array(half);
    for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
    return mag;
  }

  /** 折叠到 12 音级（以 A4=440Hz、C=0） */
  function chromaFromSpectrum(mag, sampleRate, fftSize) {
    const ch = new Float64Array(12);
    const binHz = sampleRate / fftSize;
    const minHz = 55, maxHz = 4200;
    for (let i = 1; i < mag.length; i++) {
      const f = i * binHz;
      if (f < minHz || f > maxHz) continue;
      const midi = 69 + 12 * Math.log2(f / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      ch[pc] += mag[i] * mag[i];
    }
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += ch[i];
    if (sum > 0) for (let i = 0; i < 12; i++) ch[i] /= sum;
    return ch;
  }

  /* ============================================================
     3. 五声调式检测（音级直方图 + 模板匹配）
     ============================================================ */
  // 音级序号: 0=C 1=C# 2=D 3=D# 4=E 5=F 6=F# 7=G 8=G# 9=A 10=A# 11=B
  // 五声调式是**同一音级集合**的五种主音选择，不是五张不同的音阶表。
  // 以宫=C 为例，集合恒为 C D E G A = {0,2,4,7,9}，换的只是主音落在哪一级：
  //   宫(C)  = C D E G A   → 相对主音 C: 0,2,4,7,9
  //   商(D)  = D E G A C   → 相对主音 D: 0,2,5,7,10
  //   角(E)  = E G A C D   → 相对主音 E: 0,3,5,8,10
  //   徵(G)  = G A C D E   → 相对主音 G: 0,2,5,7,9
  //   羽(A)  = A C D E G   → 相对主音 A: 0,3,5,7,10
  // 表从 PENTA_STEPS 推导，不手写——手写过一次就把宫/徵写成了同一行。
  const PENTA_STEPS = [0, 2, 4, 7, 9];
  const degreesFor = (degIndex) =>
    PENTA_STEPS.map((s) => (s - PENTA_STEPS[degIndex] + 12) % 12).sort((a, b) => a - b);
  const MODES = [
    { id: 'gong',  glyph: '宫', name: '宫调式', degIndex: 0 },
    { id: 'shang', glyph: '商', name: '商调式', degIndex: 1 },
    { id: 'jue',   glyph: '角', name: '角调式', degIndex: 2 },
    { id: 'zhi',   glyph: '徵', name: '徵调式', degIndex: 3 },
    { id: 'yu',    glyph: '羽', name: '羽调式', degIndex: 4 },
  ].map((m) => ({ ...m, degrees: degreesFor(m.degIndex) }));
  // 宫调式音级名，用于把"主音落在集合的第几级"翻译成宫商角徵羽
  const DEGREE_TO_MODE = ['gong', 'shang', 'jue', 'zhi', 'yu'];
  const MODE_BY_ID = Object.fromEntries(MODES.map((m) => [m.id, m]));
  const PC_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

  /**
   * 五声调式检测。
   * 步骤 1：在 12 个候选「宫」上匹配共用音级集合 {0,2,4,7,9}，定出集合与宫音。
   * 步骤 2：在这 5 个音级里找真正的调性中心（主音）。
   * 步骤 3：主音落在集合的第几级，就叫宫/商/角/徵/羽调式。
   */
  function detectMode(chroma) {
    if (!chroma || chroma.length < 12) {
      return {
        mode: MODES[0], root: '—', rootIndex: 0, centerIndex: 0,
        confidence: 0, pentaFit: 0, chroma: Array(12).fill(0), ranked: [],
      };
    }
    let tot = 0;
    for (let i = 0; i < 12; i++) tot += chroma[i];
    if (tot <= 0) {
      return {
        mode: MODES[0], root: '—', rootIndex: 0, centerIndex: 0,
        confidence: 0, pentaFit: 0, chroma: Array.from(chroma), ranked: [],
      };
    }

    // ---- 1) 定集合：12 个候选宫音上算「集合内均值 − 1.25 × 集合外均值」 ----
    const setScores = [];
    for (let gong = 0; gong < 12; gong++) {
      const inSet = new Array(12).fill(false);
      for (const d of PENTA_STEPS) inSet[(gong + d) % 12] = true;
      let onW = 0, offW = 0, on = 0, off = 0;
      for (let i = 0; i < 12; i++) {
        if (inSet[i]) { on++; onW += chroma[i]; }
        else { off++; offW += chroma[i]; }
      }
      const inAvg = on ? onW / on : 0;
      const outAvg = off ? offW / off : 0;
      setScores.push({ gong, score: inAvg - outAvg * 1.25, inSet, inW: onW });
    }
    setScores.sort((a, b) => b.score - a.score);
    const bestSet = setScores[0];
    const secondSet = setScores[1] || { score: 0 };
    const pentaFit = tot > 0 ? bestSet.inW / tot : 0;

    // ---- 2) 定主音：集合 5 个音级里挑调性中心 ----
    // 用「该音级能量 / 其余四级均值」做中心度，加一点点宫音先验（宫音在同分时胜出）
    const degrees = PENTA_STEPS.map((d) => (bestSet.gong + d) % 12);
    let centerIdx = 0, centerScore = -Infinity;
    const degreeScores = degrees.map((pc, i) => {
      const others = degrees.filter((_, j) => j !== i);
      const oAvg = others.reduce((a, j) => a + chroma[j], 0) / Math.max(others.length, 1);
      // 宫音先验：+6% 相对权重，帮助在五声平稳时收敛
      const centrality = chroma[pc] / Math.max(oAvg, 1e-9) * (i === 0 ? 1.06 : 1);
      return { pc, degIndex: i, centrality, weight: chroma[pc] };
    });
    degreeScores.forEach((d, i) => {
      if (d.centrality > centerScore) { centerScore = d.centrality; centerIdx = i; }
    });

    const modeId = DEGREE_TO_MODE[centerIdx];
    const mode = MODE_BY_ID[modeId];
    const center = degrees[centerIdx];

    // ---- 3) 置信度：集合区分度 × 主音区分度 × 五声符合度 × 两道可信度门 ----
    const degSorted = [...degreeScores].sort((a, b) => b.centrality - a.centrality);
    const centerMargin = degSorted[0].centrality - (degSorted[1] ? degSorted[1].centrality : 0);
    const setMargin = bestSet.score - secondSet.score;

    // (a) 音级基数可信度：五声集合只有 5 个音级。
    //     用熵指数 nEff = exp(-Σ p·ln p) 量「到底有几个音级在承重」。
    //     实测：真五声（含 FFT 窗泄漏）nEff ≈ 2.6~5.8；
    //           自然七声音阶 ≈ 7.3~8.1，半音阶/白噪 ≈ 11。
    //     nEff 明显大于 5 时，「最佳五声集合」只是大音阶里挑出的最好 5 子集，
    //     属于机会性覆盖（挑 5/12 个最重的箱总能罩住大头），不构成五声证据。
    //     拐点 6.0（真五声 p95≈5.8），斜率 0.30，地板 0.45。
    let entropy = 0;
    for (let i = 0; i < 12; i++) {
      const q = chroma[i] / tot;
      if (q > 1e-12) entropy -= q * Math.log(q);
    }
    const nEff = Math.exp(entropy);
    const cardinalityCred = clamp(1 - (nEff - 6.0) * 0.30, 0.45, 1);

    // (b) 集合选择可信度：top1 与 top2 的相对差距决定主音落在集合第几级，
    //     也就是宫/商/角/徵/羽怎么报。差距几乎为 0 时调式名就是掷硬币。
    //     实测（分母 = 集合内均值 inAvg）：28s 真五声 relMargin ≈ 0.066~0.14，
    //     24s ≈ 0.09；8s 判错宫的素材 ≈ 0.002~0.03；纯噪声 ≈ 0.02。
    //     必须用相对差距（setMargin/inAvg，量纲相消），不能用绝对 setMargin：
    //     detectMode 可能收到未归一化的色度，绝对 setMargin 随输入缩放任意漂移，
    //     ×2.2 后直接顶格 0.34 —— 集合区分度这一项就变成了缩放噪声。
    //     分母也不用 bestSet.score：纯噪声下它可为负，relMargin 会炸到天文数字。
    //     相对差距 <4% 时「宫」不是被证据挑出来的（相邻两套五声只差 1 个音级，
    //     短素材/串音地板下这 1 个音级在掷硬币），setCert 把置信度上限压下去。
    const inAvg = bestSet.inW / 5;
    const relMargin = setMargin / Math.max(inAvg, 1e-9);
    const setCert = clamp(relMargin / 0.04, 0.30, 1);

    const confidence = clamp(
      (0.18
        + clamp(relMargin * 2.2, 0, 0.34)
        + clamp(centerMargin * 0.22, 0, 0.28)
        + clamp((pentaFit - 0.4) * 1.1, 0, 0.22)) * cardinalityCred * setCert,
      0.05, 0.97
    );

    return {
      mode,
      root: PC_NAMES[center],          // 主音（调性中心）
      rootIndex: center,
      gongRoot: PC_NAMES[bestSet.gong], // 宫音（集合参照）
      gongIndex: bestSet.gong,
      degIndex: centerIdx,
      confidence: Math.round(confidence * 100) / 100,
      pentaFit: Math.round(pentaFit * 1000) / 1000,
      /* 证据链：为什么判成这个调式的原始分数（页面证据面板用） */
      nEff: Math.round(nEff * 100) / 100,
      relMargin: Math.round(relMargin * 1000) / 1000,
      setCert: Math.round(setCert * 1000) / 1000,
      degScores: degreeScores.map((d) => ({
        pc: PC_NAMES[d.pc],
        centrality: Math.round(d.centrality * 1000) / 1000,
        weight: Math.round(d.weight * 1000) / 1000,
      })),
      chroma: Array.from(chroma),
      ranked: setScores.slice(0, 5).map((s) => ({
        mode: MODES[s.gong === bestSet.gong ? centerIdx : 0].glyph,
        root: PC_NAMES[s.gong],
        score: Math.round(s.score * 1000) / 1000,
      })),
    };
  }

  /* ============================================================
     3b. 大调 / 小调（西方调性标注）
     ------------------------------------------------------------
     五声调式回答的是「主音 + 宫体系里的位置」，用户还要一眼知道
     这歌读起来是大调还是小调。两路证据合并：
     a) Krumhansl–Schmuckler 大/小调音阶模板，转到主音上与色度做相关
        —— 对七声、带半音的素材最稳。
     b) 主音上方三度的正面对决：大三度 (t+4) vs 小三度 (t+3) 的能量差。
        五声内部宫/角/徵直接有答案；商/徵没有三度时色度里照样测得到
        （chroma 来自全频段 FFT，泛音会把三度填出来）。
     合并取大，差值给置信度；两边打平就老实报低置信。
     ============================================================ */
  const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function detectTonality(chroma, tonicIndex) {
    const fallback = { tonality: 'major', name: '大调', confidence: 0, rMajor: 0, rMinor: 0, third: 0 };
    if (!chroma || chroma.length < 12 || !(tonicIndex >= 0 && tonicIndex < 12)) return fallback;
    let tot = 0;
    for (let i = 0; i < 12; i++) tot += Math.max(0, chroma[i]);
    if (!(tot > 0)) return fallback;

    // 主音转到 0 位，和 K-S 模板同向
    const rot = new Array(12);
    for (let i = 0; i < 12; i++) rot[i] = Math.max(0, chroma[(tonicIndex + i) % 12]);
    const rotMean = rot.reduce((a, b) => a + b, 0) / 12;
    const corr = (profile) => {
      const pm = profile.reduce((a, b) => a + b, 0) / 12;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < 12; i++) {
        const x = rot[i] - rotMean, y = profile[i] - pm;
        num += x * y; da += x * x; db += y * y;
      }
      return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
    };
    const rMaj = corr(KS_MAJOR);
    const rMin = corr(KS_MINOR);

    // 三度证据：归一化到 (−1, 1)，两边都没有能量时为 0
    const t3 = Math.max(0, chroma[(tonicIndex + 3) % 12]);
    const t4 = Math.max(0, chroma[(tonicIndex + 4) % 12]);
    const third = (t4 - t3) / Math.max(t4 + t3, 1e-9);

    const majScore = rMaj + 0.35 * third;
    const minScore = rMin - 0.35 * third;
    const tonality = majScore >= minScore ? 'major' : 'minor';
    const margin = Math.abs(majScore - minScore);
    // 模板相关本身的差距（0~0.5 量级）+ 三度差距，合起来映射到 0~0.95
    const confidence = clamp(Math.round(margin * 150) / 100, 0, 0.95);
    return {
      tonality,
      name: tonality === 'major' ? '大调' : '小调',
      confidence: margin < 0.02 ? 0 : confidence,
      rMajor: Math.round(rMaj * 1000) / 1000,
      rMinor: Math.round(rMin * 1000) / 1000,
      third: Math.round(third * 1000) / 1000,
      /* 证据链：合并前的两路分数与差距（页面证据面板用） */
      majScore: Math.round(majScore * 1000) / 1000,
      minScore: Math.round(minScore * 1000) / 1000,
      margin: Math.round(margin * 1000) / 1000,
    };
  }

  /* ============================================================
     4. BPM / 节拍（能量包络自相关 + IQR 融合）
     ============================================================ */
function estimateBPM(data, sampleRate) {
    const hop = 512;
    const frame = 1024;
    const n = Math.floor((data.length - frame) / hop);
    const fps = sampleRate / hop;
    if (n < 32) return { bpm: 0, confidence: 0, envelope: [], envFps: fps };
  
    /* ---- 起音包络（与 v1 契约一致）---- */
    const env = new Float64Array(n);
    let prev = 0;
    for (let i = 0; i < n; i++) {
      let e = 0;
      const off = i * hop;
      for (let k = 0; k < frame; k++) {
        const s = data[off + k] || 0;
        e += s * s;
      }
      e = Math.sqrt(e / frame);
      env[i] = Math.max(0, e - prev * 0.92);
      prev = e;
    }
    const mean = env.reduce((a, b) => a + b, 0) / n;
    for (let i = 0; i < n; i++) env[i] -= mean;
  
    /* ---- 自相关：40–240 BPM ---- */
    const maxLag = Math.min(Math.floor(fps * 60 / 40), n - 2);
    const minLag = Math.max(2, Math.floor(fps * 60 / 240));
    if (maxLag <= minLag + 2) return { bpm: 0, confidence: 0, envelope: Array.from(env), envFps: fps };
  
    const ac = new Float64Array(maxLag + 1);
    let acMax = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i < n - lag; i++) s += env[i] * env[i + lag];
      ac[lag] = s / (n - lag);
      if (ac[lag] > acMax) acMax = ac[lag];
    }
    if (!(acMax > 0)) return { bpm: 0, confidence: 0, envelope: Array.from(env), envFps: fps };
  
    const acAt = (x) => {
      const i = Math.round(x);
      if (i < minLag || i > maxLag) return 0;
      return ac[i];
    };
  
    /* ---- 峰 + 抛物线插值 ---- */
    const peaks = [];
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1] && ac[lag] > 0) {
        const y0 = ac[lag - 1], y1 = ac[lag], y2 = ac[lag + 1];
        const d = y0 - 2 * y1 + y2;
        const delta = Math.abs(d) > 1e-18 ? 0.5 * (y0 - y2) / d : 0;
        peaks.push({ lag, v: y1, tau: lag + (Math.abs(delta) < 1 ? delta : 0) });
      }
    }
    if (!peaks.length) return { bpm: 0, confidence: 0, envelope: Array.from(env), envFps: fps };
    const strongest = peaks.reduce((a, b) => (b.v > a.v ? b : a), peaks[0]);
  
    /* ---- IOI 直方图（拍长的直接观测）----
       起音取包络的**全部局部极大**（不设高阈值），按峰高加权计数。
       旧做法用 p82 阈值会漏掉弱拍（click 风格的 0.26 弱拍），
       于是相邻起音间隔变成 2 拍 —— IOI 众数反而指向小节，投票就会反向。 */
    let ioiBest = 0, ioiW = 0, ioiSecond = 0, onsetCount = 0;
    const onsets = [];   // 提到块外：下面的集中度精化要用同一份起音表
    {
      for (let i = 1; i < n - 1; i++) {
        if (env[i] > 0 && env[i] >= env[i - 1] && env[i] > env[i + 1]) {
          if (onsets.length && i - onsets[onsets.length - 1].t < minLag * 0.45) {
            if (env[i] > onsets[onsets.length - 1].w) onsets[onsets.length - 1] = { t: i, w: env[i] };
            continue;
          }
          onsets.push({ t: i, w: env[i] });
        }
      }
      onsetCount = onsets.length;
      const hist = new Map();
      for (let i = 1; i < onsets.length; i++) {
        const d = onsets[i].t - onsets[i - 1].t;
        if (d < minLag * 0.5 || d > maxLag) continue;
        const wgt = Math.sqrt(onsets[i].w * onsets[i - 1].w);
        const key = Math.round(d);
        for (let k = key - 1; k <= key + 1; k++) {
          if (k >= minLag * 0.5 && k <= maxLag) hist.set(k, (hist.get(k) || 0) + (k === key ? wgt : wgt * 0.35));
        }
      }
      for (const [, w] of hist) {
        if (w > ioiW) { ioiSecond = ioiW; ioiW = w; }
        else if (w > ioiSecond) ioiSecond = w;
      }
      for (const [k, w] of hist) if (w === ioiW) { ioiBest = k; break; }
  
      // IOI 众数同样要往下除：起音漏检会让众数落在 2 拍/3 拍上
      if (ioiBest > 0) {
        let t = ioiBest;
        for (let step = 0; step < 4; step++) {
          let moved = false;
          for (const d of [2, 3]) {
            const sub = Math.round(t / d);
            if (sub < minLag * 0.5) continue;
            let subW = 0;
            for (let k = sub - 1; k <= sub + 1; k++) subW = Math.max(subW, hist.get(k) || 0);
            if (subW >= 0.38 * (hist.get(t) || ioiW)) { t = sub; moved = true; break; }
          }
          if (!moved) break;
        }
        ioiBest = t;
        ioiW = hist.get(ioiBest) || ioiW;
        for (const [k, w] of hist) if (k !== ioiBest && w > ioiSecond && w <= ioiW) ioiSecond = w;
      }
    }
  
    /* ---- 八度消歧：从最强峰往下除 ---- */
    const ALPHA = 0.42;   // 八度消歧阈值：ac(τ/d) ≥ ALPHA·ac(τ) 就认为 τ/d 是拍
    let tau = strongest.tau;
    const path = [tau];
    for (let step = 0; step < 6; step++) {
      let moved = false;
      for (const d of [2, 3, 4]) {
        const sub = tau / d;
        if (sub < minLag) continue;
        // τ/d 上要么有峰，要么 ac 本身就够强（量化后峰位偏移）
        const subAc = Math.max(acAt(sub), acAt(sub - 1), acAt(sub + 1));
        if (subAc >= ALPHA * acAt(tau)) {
          tau = sub;
          moved = true;
          break;
        }
      }
      if (!moved) break;
      path.push(tau);
    }
  
    /* ---- IOI 投票 ----
       IOI 众数若强烈支持 tau / 2 或 2·tau，则采用 IOI。
       「强烈」= 众数计数是次高值的 1.25 倍以上，且至少 3 次。 */
    let ioiAgree = 0;
    if (ioiBest > 0 && ioiW > 0) {
      const rel = (x, y) => Math.abs(x - y) / Math.max(y, 1);
      const decisive = ioiW >= Math.max(ioiSecond * 1.25, 3);
      if (rel(ioiBest, tau) <= 0.07) ioiAgree = 1;
      else if (decisive && rel(ioiBest, tau / 2) <= 0.08 && rel(ioiBest, tau) > 0.12) tau = ioiBest;
      else if (decisive && rel(ioiBest, tau * 2) <= 0.08 && rel(ioiBest, tau) > 0.12) tau = ioiBest;
    }
  
    /* ---- 精化：在 tau 附近最大化「家族梳状」得分 ---- */
    const comb = (t) => {
      if (!(t > 1)) return 0;
      return acAt(t) + 0.55 * acAt(t * 2) + 0.30 * acAt(t * 3) + 0.16 * acAt(t * 4);
    };
    {
      let bestT = tau, bestS = comb(tau);
      for (let d = -2.5; d <= 2.5; d += 0.25) {
        const s = comb(tau + d);
        if (s > bestS) { bestS = s; bestT = tau + d; }
      }
      tau = bestT;
    }
  
    /* ---- 集中度精化：comb 对 τ 的千分之二误差不敏感，但拍号估计对它致命 ----
       固定网格下起音是否同相，最优统计量是加权 Rayleigh 集中度
       |Σ w·e^{i2πt/τ}| / Σw。实测（《龙城风》204s）：τ 差 0.25%，分 30s 窗
       集中度 0.42–0.53，全曲掉到 0.04 —— 周期误差让相位在几分钟内漂掉
       一整拍，后面的小节估计全部失效。所以在 ±0.6 帧上扫一遍取峰，
       把 BPM 收到 0.01 帧（约 0.03 BPM）以内。 */
    if (onsets.length >= 24) {
      let tauBest = tau, bestConc = -Infinity;
      for (let d = -0.6; d <= 0.6001; d += 0.01) {
        const t = tau + d;
        if (!(t >= minLag) || t > maxLag) continue;
        let x = 0, y = 0, sw = 0;
        for (let j = 0; j < onsets.length; j++) {
          const a = (2 * Math.PI * onsets[j].t) / t;
          const w = onsets[j].w;
          x += w * Math.cos(a); y += w * Math.sin(a); sw += w;
        }
        if (!(sw > 0)) continue;
        const c = Math.hypot(x, y) / sw;
        if (c > bestConc) { bestConc = c; tauBest = t; }
      }
      tau = tauBest;
    }

    const bpm = Math.round(((fps * 60) / tau) * 10) / 10;
    if (!(bpm > 20) || !Number.isFinite(bpm)) {
      return { bpm: 0, confidence: 0, envelope: Array.from(env), envFps: fps, evidence: null };
    }
  
    /* ---- 置信度 ---- */
    const sortedByV = peaks.slice().sort((a, b) => b.v - a.v);
    const dominance = sortedByV.length > 1 ? sortedByV[0].v / Math.max(sortedByV[1].v, 1e-12) : 2;
    let aligned = 0, strongN = 0;
    for (const p of peaks) {
      if (p.v < acMax * 0.35) continue;
      strongN++;
      const r = p.tau / tau;
      for (const k of [0.5, 1, 2, 3, 4, 6]) {
        if (Math.abs(r - k) <= 0.07) { aligned++; break; }
      }
    }
    const famScore = strongN ? aligned / strongN : 0.5;
    const ioiScore = ioiAgree ? 1 : (ioiBest > 0 ? 0.5 : 0.62);
    // 起音密度合理性：起音数应接近 时长/拍长 的 0.4–2 倍
    const expectOnsets = (n / fps) / (tau / fps);
    const densRatio = expectOnsets > 0 ? onsetCount / expectOnsets : 1;
    const densScore = densRatio > 0.35 && densRatio < 3.2 ? 1 : densRatio > 0.2 && densRatio < 5 ? 0.55 : 0.2;
  
    const confidence = Math.round(Math.min(0.97, Math.max(0.12,
      0.18
      + Math.min(dominance - 1, 1.5) * 0.13
      + famScore * 0.28
      + ioiScore * 0.20
      + densScore * 0.12
    )) * 1000) / 1000;

    /* 证据链：候选拍峰与置信度分量，页面「证据」面板拿它画原图。
       只多带数据，不改既有字段——存盘与测试契约原样。 */
    const evidence = {
      tau: Math.round(tau * 100) / 100,
      envFps: fps,
      peaks: peaks
        .map((p) => ({ bpm: Math.round(((fps * 60) / p.tau) * 10) / 10, v: Math.round(p.v * 10000) / 10000 }))
        .filter((p) => p.bpm >= 40 && p.bpm <= 240)
        .sort((a, b) => b.v - a.v)
        .slice(0, 8),
      dominance: Math.round(dominance * 1000) / 1000,
      famScore: Math.round(famScore * 1000) / 1000,
      ioiScore: Math.round(ioiScore * 1000) / 1000,
      densScore: Math.round(densScore * 1000) / 1000,
      onsetCount,
    };

    return { bpm, confidence, envelope: Array.from(env), envFps: fps, evidence };
  }

  /* ============================================================
     4b. 拍号估计
     ------------------------------------------------------------
     在 2/4 · 3/4 · 4/4 · 6/8 里选一个：按拍间隔把起音包络切成
     小节级候选周期，比较各自周期上的能量对齐程度，取最强者。
     对不上的时候老实回 4/4，不编数字。
     ============================================================ */
function estimateMeter(envelope, fps, bpm) {
  // 常量内联：splice 只搬函数体，模块级常量进不了 engine.js
  const TEMPLATES = {
    '2/4': [1.0, 0.52],
    '3/4': [1.0, 0.50, 0.50],
    '4/4': [1.0, 0.55, 0.76, 0.55],
    '5/4': [1.0, 0.50, 0.50, 0.78, 0.50],
    '6/8': [1.0, 0.46, 0.46, 0.80, 0.46, 0.46],
    '7/8': [1.0, 0.50, 0.50, 0.80, 0.50, 0.50, 0.50],
  };
  const CANDS = [
    { meter: '2/4', B: 2 },
    { meter: '3/4', B: 3 },
    { meter: '4/4', B: 4 },
    { meter: '5/4', B: 5 },
    { meter: '6/8', B: 6 },
    { meter: '7/8', B: 7 },
  ];
  /* 留空也要交代原因：证据链面板要把「为什么没测出」如实展示出来。 */
  const weak = (scores, reason, info) => ({
    meter: null, confidence: 0, scores: scores || [],
    reason: reason || 'input', info: info || null,
  });
  if (!envelope || envelope.length < 64 || !(bpm > 25) || !(fps > 0)) return weak(null, 'input');
  const beatLag = (60 / bpm) * fps;
  if (!(beatLag >= 2) || beatLag > envelope.length / 2) return weak(null, 'beatlag');
  const n = envelope.length;

  /* ---- 1. 起音 → 每拍强度 ----
     两件事决定成败：
     a) 用「窗口内正部积分」而不是「最大值」。包络是去均值的，起音峰值
        只有 1–2 个 hop 宽，落点相对 hop 格有量化抖动，取 max 会把抖动
        当成强弱差异（交替轮廓被抹平到 R²≈0.48，正部积分立刻 ≈0.97）。
     b) 拍网格要**分窗重新对相**。周期再精，长曲上真实的速度游走也会
        让固定网格漂掉（实测《龙城风》：30s 窗内起音相位集中度 0.42，
        全曲 0.04）。旧实现按 8 拍窗最大化「窗内正部之和」——这个目标
        对噪声和窗宽都敏感，会把每窗随机甩到 ±1/3 拍外，反而毁掉强弱
        对比（R² 只剩 0.09）。改为每窗求**复数相位**（加权 Rayleigh 的
        arg）：固定周期下起音相位的最优估计；跨窗解卷绕成连续漂移曲线，
        按拍插值后取样。窗口自身集中度低（起音稀/弱）时不参与，由邻窗
        插值补齐。 */
  const nBeats = Math.floor((n - 1) / beatLag);
  if (nBeats < 10) return weak(null, 'too-few-beats');
  const wL = Math.max(1, Math.floor(beatLag * 0.18));
  const wR = Math.max(1, Math.ceil(beatLag * 0.22));

  const positiveSum = (center) => {
    const c = Math.round(center);
    let acc = 0;
    for (let i = Math.max(0, c - wL); i <= Math.min(n - 1, c + wR); i++) {
      const v = envelope[i];
      if (v > 0) acc += v;
    }
    return acc;
  };

  // 每拍的相位偏移 f(k)（单位：拍，可超出 ±0.5 —— 解卷绕后的漂移曲线）
  const fracOfBeat = new Float64Array(nBeats).fill(0);
  {
    const W = 64, HOP = 32;               // 窗宽/步进（拍）：W 足够估相位，HOP 足够跟漂移
    const winK0 = [];
    for (let k0 = 0; k0 < nBeats; k0 += HOP) winK0.push(k0);
    const nWin = winK0.length;
    const frac = new Float64Array(nWin);
    const valid = new Uint8Array(nWin);
    const weight = new Float64Array(nWin);
    for (let w = 0; w < nWin; w++) {
      const i0 = Math.max(0, Math.floor(winK0[w] * beatLag));
      const i1 = Math.min(n - 1, Math.ceil((winK0[w] + W) * beatLag));
      let x = 0, y = 0, sw = 0;
      for (let i = i0; i <= i1; i++) {
        const v = envelope[i];
        if (v <= 0) continue;
        const a = (2 * Math.PI * i) / beatLag;
        x += v * Math.cos(a); y += v * Math.sin(a); sw += v;
      }
      if (sw <= 1e-12) { frac[w] = 0; valid[w] = 0; weight[w] = 0; continue; }
      frac[w] = Math.atan2(y, x) / (2 * Math.PI);       // ∈ (−0.5, 0.5]
      const conc = Math.hypot(x, y) / sw;
      valid[w] = conc > 0.04 ? 1 : 0;                    // 集中度太低 = 这窗估不出相位
      weight[w] = sw * conc;
    }
    // 解卷绕：相邻窗真实漂移远小于半拍，跨过 ±0.5 边界时补 ±1
    let prev = NaN;
    for (let w = 0; w < nWin; w++) {
      if (!valid[w]) continue;
      if (!Number.isNaN(prev)) {
        while (frac[w] - prev > 0.5) frac[w] -= 1;
        while (prev - frac[w] > 0.5) frac[w] += 1;
      }
      prev = frac[w];
    }
    // 无效窗：在有效邻居间线性插值；两端用最近有效值外推；全程无效则保持 0
    let firstValid = -1;
    for (let w = 0; w < nWin; w++) if (valid[w]) { firstValid = w; break; }
    if (firstValid < 0) return weak(null, 'no-valid-window');
    for (let w = 0; w < nWin; w++) {
      if (valid[w]) continue;
      let a = -1, b = -1;
      for (let j = w - 1; j >= 0; j--) if (valid[j]) { a = j; break; }
      for (let j = w + 1; j < nWin; j++) if (valid[j]) { b = j; break; }
      if (a >= 0 && b >= 0) frac[w] = frac[a] + (frac[b] - frac[a]) * ((w - a) / (b - a));
      else if (a >= 0) frac[w] = frac[a];
      else frac[w] = frac[b];
    }
    // 轻度平滑（3 点加权均值，权重=窗能量×集中度），去掉单窗的估计毛刺
    const raw = Float64Array.from(frac);
    const wsum = Float64Array.from(weight);
    for (let w = 0; w < nWin; w++) {
      let num = 0, den = 0;
      for (let j = Math.max(0, w - 1); j <= Math.min(nWin - 1, w + 1); j++) {
        const ww = Math.max(wsum[j], 1e-9);
        num += raw[j] * ww; den += ww;
      }
      frac[w] = num / den;
    }
    // 拍 k 的相位 = 所属窗的相位；同窗内恒定，窗间用窗心做线性插值
    const centerBeat = (w) => winK0[w] + W / 2;
    for (let k = 0; k < nBeats; k++) {
      // 找包围 k 的窗心
      let w1 = 0;
      while (w1 + 1 < nWin && centerBeat(w1 + 1) < k) w1++;
      const w0 = w1;
      let f;
      if (w1 + 1 < nWin) {
        const c0 = centerBeat(w0), c1 = centerBeat(w1 + 1);
        const u = (k - c0) / Math.max(c1 - c0, 1);
        f = frac[w0] + (frac[w1 + 1] - frac[w0]) * Math.min(Math.max(u, 0), 1);
      } else f = frac[w0];
      fracOfBeat[k] = f;
    }
  }

  const s = new Float64Array(nBeats);
  for (let k = 0; k < nBeats; k++) s[k] = positiveSum((k + fracOfBeat[k]) * beatLag);

  let sSum = 0, sSq = 0;
  for (let k = 0; k < nBeats; k++) { sSum += s[k]; sSq += s[k] * s[k]; }
  const sMean = sSum / nBeats;
  const sst = sSq - nBeats * sMean * sMean;
  if (!(sSum > 1e-12) || !(sst > 1e-18)) return weak(null, 'flat-envelope');

  /* ---- 2. 周期模型的 R² + 相位搜索 ---- */
  const fitAt = (B) => {
    let bestR2 = -Infinity, bestP = null, bestPhase = 0;
    for (let phase = 0; phase < B; phase++) {
      const p = new Float64Array(B), cnt = new Int32Array(B);
      for (let k = 0; k < nBeats; k++) {
        const b = (k + phase) % B;
        p[b] += s[k]; cnt[b]++;
      }
      for (let b = 0; b < B; b++) p[b] /= Math.max(cnt[b], 1);
      let sse = 0;
      for (let k = 0; k < nBeats; k++) {
        const d = s[k] - p[(k + phase) % B];
        sse += d * d;
      }
      const r2 = 1 - sse / sst;
      if (r2 > bestR2) { bestR2 = r2; bestP = p; bestPhase = phase; }
    }
    return { r2: bestR2, p: bestP, phase: bestPhase };
  };

  const pearson = (a, b) => {
    const m = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < m; i++) { ma += a[i]; mb += b[i]; }
    ma /= m; mb /= m;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < m; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
  };

  /* 模板相关要**循环移位取最大**。拍网格的原点是任意的（分窗相位只保证
     采样贴着起音，不保证第 0 拍是下拍），p[0] 落在小节的哪个位置纯属
     偶然。实测《龙城风》：下拍在 bin3，绝对标号直接比得 r=−0.565，
     移位对齐后 r=0.79 —— 不移位会把真实的 4/4 判成「形状不像」。 */
  const pearsonShift = (a, b) => {
    let best = -1;
    for (let sh = 0; sh < a.length; sh++) {
      const r = pearson(a.map((_, i) => a[(i + sh) % a.length]), b);
      if (r > best) best = r;
    }
    return best;
  };

  /* ---- 2b. 交叉验证（跨时段稳定性判据）----
     问的是：前半的强弱规律，后半还成立吗？——按**每半段的 B 格均值**
     做相关，而不是「前半均值预测后半逐样本的 R²」。
     旧的样本级 CV 有两个致命伤：(a) 逐样本方差被拍内噪声主导，真拍号
     也只能解释其中三成；(b) 前后半整体电平一变（本曲 0.107 → 0.137）
     预测直接崩到 0.08，而两半的强弱秩序其实一致（相关 0.956）。
     格均值相关对电平不敏感，测的正是「规律是否同一张」。
     噪声拒绝由全量 r2max 门扛（分窗相位不制造周期对比，白噪的全量
     R² ≈ B/N ≈ 0.01，过不了 0.24 的门）。 */
  const cvR2At = (B) => {
    const h = Math.floor(nBeats / 2);
    if (h < Math.max(B, 4)) return -1;
    const halfMeans = (a, b) => {
      const p = new Float64Array(B), cnt = new Int32Array(B);
      for (let k = a; k < b; k++) { const bb = ((k % B) + B) % B; p[bb] += s[k]; cnt[bb]++; }
      for (let bb = 0; bb < B; bb++) p[bb] = cnt[bb] ? p[bb] / cnt[bb] : 0;
      return Array.from(p);
    };
    return pearson(halfMeans(0, h), halfMeans(h, nBeats));
  };

  const scored = CANDS.map((c) => {
    const f = fitAt(c.B);
    const r = pearsonShift(Array.from(f.p), TEMPLATES[c.meter]);
    return {
      meter: c.meter,
      B: c.B,
      r2: Math.round(Math.max(0, f.r2) * 1000) / 1000,
      r: Math.round(r * 1000) / 1000,
      cv: Math.round(cvR2At(c.B) * 1000) / 1000,
      s: Math.round(Math.max(0, f.r2) * 1000) / 1000,
    };
  });

  const byB = Object.fromEntries(scored.map((x) => [x.B, x]));
  const r2max = Math.max(...scored.map((x) => x.r2));
  const cvMax = Math.max(...scored.map((x) => x.cv));

  /* ---- 2c. 留空：没有「跨时段稳定」的强弱周期 ----
     CV R² 是噪声闸门。真拍号 cv≈0.9+，白噪 cv 大负 —— 中间几乎没东西。 */
  if (cvMax < 0.12) return weak(scored, 'cv', { cvMax: Math.round(cvMax * 1000) / 1000, r2max: Math.round(r2max * 1000) / 1000, gate: 0.12 });

  /* ---- 3. 取「解释力足够」的最小 B ---- */
  const EPS = 0.035;              // R² 允许落后这么多
  const REL = 0.955;              // 或者达到最高 R² 的这个比例
  const viable = scored
    .filter((x) => x.r2 >= r2max - EPS && x.r2 >= r2max * REL)
    .sort((a, b) => a.B - b.B);

  /* ---- 4. 留空判据 ---- */
  // R² 太低 = 没有稳定的强弱周期。门位按三档标定：
  //   真拍号《龙城风》mono mix 0.276 / ch0 0.296（通道混合会挪 ±0.02）；
  //   无强弱周期《红头绳》0.072；白噪 ≈ B/N ≈ 0.01。
  //   0.24 站在真值一侧又给混合差异留了头寸——0.28 会把 0.276 误杀。
  if (r2max < 0.24) return weak(scored, 'r2', { r2max: Math.round(r2max * 1000) / 1000, gate: 0.24, cvMax: Math.round(cvMax * 1000) / 1000 });
  const sorted = scored.slice().sort((a, b) => b.r2 - a.r2);
  const chosen = viable[0] || sorted[0];
  // 「对手」= 周期既不是 chosen.B 的整数倍、也不是它的约数
  // （倍数/约数只是同一基频的另一种折叠，不是竞争假说）
  const isMultiple = (a, b) => b % a === 0;
  const rival = scored
    .filter((x) => x.B !== chosen.B && !isMultiple(chosen.B, x.B) && !isMultiple(x.B, chosen.B))
    .sort((a, b) => b.r2 - a.r2)[0];
  const gap = rival ? chosen.r2 - rival.r2 : 0.5;
  if (rival && gap < 0.035) return weak(scored, 'gap', { gap: Math.round(gap * 1000) / 1000, gate: 0.035, r2max: Math.round(r2max * 1000) / 1000 });
  if (chosen.r < 0.30) return weak(scored, 'shape', { r: Math.round(chosen.r * 1000) / 1000, gate: 0.30, r2max: Math.round(r2max * 1000) / 1000 });

  /* ---- 5. 形状复核（防止周期对了但强弱不像）---- */
  let meter = chosen.meter;
  // 双/三拍族的兜底：万一周期判断糊了，用族内模板相关挑
  if (chosen.B === 4 && byB[2].r2 > byB[4].r2 - 0.01 && byB[2].r > byB[4].r) meter = '2/4';
  if (chosen.B === 6 && byB[3].r2 > byB[6].r2 - 0.01 && byB[3].r > byB[6].r) meter = '3/4';

  /* ---- 6. 置信度校准 ---- */
  const conf = Math.min(0.94, Math.max(0.05,
    (r2max - 0.22) * 1.05
    + Math.min(Math.max(gap, 0), 0.35) * 1.30
    + (chosen.r - 0.30) * 0.55
  ));
  return {
    meter,
    confidence: Math.round(conf * 100) / 100,
    scores: scored.sort((a, b) => b.r2 - a.r2),
    /* 证据链：通过了哪几道门、门位是多少、对手是谁——页面原样展示 */
    reason: null,
    info: {
      r2max: Math.round(r2max * 1000) / 1000,
      cvMax: Math.round(cvMax * 1000) / 1000,
      gap: Math.round(gap * 1000) / 1000,
      r: Math.round(chosen.r * 1000) / 1000,
      rival: rival ? rival.meter : null,
      gates: { cv: 0.12, r2: 0.24, gap: 0.035, shape: 0.30 },
    },
  };
}

  /* ============================================================
     5. 音质指标
     ============================================================ */
function qualityMetrics(data, sampleRate) {
  // 内联：splice 只搬函数体
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const dbFrom = (x) => 20 * Math.log10(Math.max(x, 1e-9));

  let sumSq = 0, peak = 0, dc = 0;
  for (let i = 0; i < data.length; i++) {
    sumSq += data[i] * data[i];
    peak = Math.max(peak, Math.abs(data[i]));
    dc += data[i];
  }
  const rms = Math.sqrt(sumSq / Math.max(data.length, 1));
  dc /= Math.max(data.length, 1);

  /* ---- LRA：1.5 秒短时窗 / 0.5 秒滑动 ----
     旧的 3 秒不重叠块在短素材上只有几个样本，且把音符级动态抹平。
     1.5s 仍远离「单个起音打满」的 0.4s 量级，但能分开压缩前后。 */
  const winSec = 1.5, hopSec = 0.5;
  const block = Math.max(1, Math.floor(sampleRate * winSec));
  const hop = Math.max(1, Math.floor(sampleRate * hopSec));
  const short = [];
  for (let i = 0; i + block <= data.length; i += hop) {
    let s = 0;
    for (let k = 0; k < block; k++) s += data[i + k] * data[i + k];
    const r = Math.sqrt(s / block);
    if (r > 1e-7) short.push(r);
  }
  let lra = 0;
  if (short.length >= 2) {
    short.sort((a, b) => a - b);
    // 相对门限：丢掉比整体响度低 20dB 的块（近静音/停顿）
    const p10raw = short[Math.floor(short.length * 0.1)];
    const gated = short.filter((r) => r > p10raw * 0.1);
    const src = gated.length >= 2 ? gated : short;
    const p10 = src[Math.floor(src.length * 0.1)];
    const p95 = src[Math.min(src.length - 1, Math.floor(src.length * 0.95))];
    lra = Math.max(0, dbFrom(p95) - dbFrom(p10));
  }

  /* ---- 频谱统计 + 谐波异常 + 低频画像 ---- */
  const size = 4096, window = hann(size), hopSpec = 2048;
  let centroidAcc = 0, rolloffAcc = 0, flatAcc = 0, frames = 0, specFrames = 0;
  let lowEnergy = 0, totalEnergy = 0, subEnergy = 0;
  // 谐波外残余能量比 + 具备可辨谐波结构的帧数
  const residualRatios = [];
  let structuredFrames = 0;
  // 低中频（150–400Hz）总能量 与 其中落在谐波峰上的能量
  let mudBandE = 0, mudMaskedE = 0;
  const avgSpectrum = new Float64Array(size >> 1); // 累加的是功率，不是幅值

  for (let off = 0; off + size < data.length; off += hopSpec) {
    const mag = frameSpectrum(data, off, size, window);
    let eSum = 0, cSum = 0;
    for (let i = 1; i < mag.length; i++) {
      const f = (i * sampleRate) / size;
      const p = mag[i] * mag[i];
      avgSpectrum[i] += p;
      eSum += p;
      cSum += f * p;
      if (f < 80) lowEnergy += p;
      if (f < 35) subEnergy += p;
    }
    totalEnergy += eSum;
    if (eSum > 1e-12) {
      specFrames++;
      centroidAcc += cSum / eSum;
      // rolloff 85%
      let acc = 0;
      for (let i = 1; i < mag.length; i++) {
        acc += mag[i] * mag[i];
        if (acc >= eSum * 0.85) {
          rolloffAcc += (i * sampleRate) / size;
          break;
        }
      }
      // spectral flatness
      let logSum = 0, linSum = 0, cnt = 0;
      for (let i = 2; i < mag.length; i++) {
        const v = mag[i] * mag[i] + 1e-12;
        logSum += Math.log(v); linSum += v; cnt++;
      }
      if (cnt) flatAcc += Math.exp(logSum / cnt) / (linSum / cnt);
    }

    /* —— 谐波外残余能量比 ——
       复音混音没有「单一基频」，经典 THD 测不了。这里改测：
       把帧内显著峰及其 2–5 次谐波视为「谐波结构」，剩下的能量就是残余。
       干净素材能量集中在泛音列上，残余小；失真 / 底噪 / AI 伪影会把
       能量抹到谐波之间，残余大。直接报这个比值，不做二次映射。 */
    const mask = new Uint8Array(mag.length);
    // 找显著峰：高于本帧均值 3 倍的局部极大
    const pow = new Float64Array(mag.length);
    let pSum = 0;
    for (let i = 1; i < mag.length; i++) { pow[i] = mag[i] * mag[i]; pSum += pow[i]; }
    const pMean = pSum / Math.max(mag.length - 1, 1);
    const peaksF = [];
    for (let i = 2; i < mag.length - 2; i++) {
      if (pow[i] > pMean * 3 && pow[i] > pow[i - 1] && pow[i] > pow[i + 1]) {
        peaksF.push(i);
      }
    }
    peaksF.sort((a, b) => pow[b] - pow[a]);
    const used = peaksF.slice(0, 14);
    if (used.length >= 3) {
      for (const p of used) {
        for (let k = 1; k <= 5; k++) {
          const hb = Math.round(p * k);
          for (let d = -2; d <= 2; d++) {
            const j = hb + d;
            if (j > 0 && j < mag.length) mask[j] = 1;
          }
        }
      }
      let maskedE = 0, totE = 0;
      for (let i = 1; i < mag.length; i++) {
        totE += pow[i];
        if (mask[i]) maskedE += pow[i];
        // 低中频：只统计 150–400Hz，用于「谐波间涂抹」
        const f = (i * sampleRate) / size;
        if (f >= 150 && f <= 400) {
          mudBandE += pow[i];
          if (mask[i]) mudMaskedE += pow[i];
        }
      }
      if (totE > 1e-14) {
        residualRatios.push(1 - maskedE / totE);
        // 峰结构清晰度：这些峰覆盖了多少能量，太低说明这帧没有可辨的谐波列
        if (maskedE / totE > 0.35) structuredFrames++;
      }
    }
    frames++;
  }

  const centroid = specFrames ? centroidAcc / specFrames : 0;
  const rolloff = specFrames ? rolloffAcc / specFrames : 0;
  const flatness = specFrames ? flatAcc / specFrames : 0;
  // 用中位数，抗离群帧；同时给出「有多少帧具备可辨谐波结构」
  let thd = 0, thdCoverage = 0;
  if (residualRatios.length) {
    residualRatios.sort((a, b) => a - b);
    thd = clamp(residualRatios[Math.floor(residualRatios.length / 2)], 0, 1);
    thdCoverage = structuredFrames / Math.max(frames, 1);
  }
  const lowRatio = totalEnergy > 0 ? lowEnergy / totalEnergy : 0;
  const subRatio = totalEnergy > 0 ? subEnergy / totalEnergy : 0;

  /* ---- 低频缺陷分 = max(谐波间涂抹, 工频哼声) ---- */

  /* (a) 低中频谐波间涂抹
        150–400Hz 里不在谐波峰上的能量占比。干净有调素材的能量压在
        泛音列上（合成用例这一带全是基频峰），涂抹低；糊掉/浑浊的
        素材在谐波之间摊开，涂抹高。占比类指标测的是音色不是缺陷，
        会永久饱和，所以不用。 */
  const mudSmear = mudBandE > 1e-18 ? clamp(1 - mudMaskedE / mudBandE, 0, 1) : 0;

  /* (b) 低频窄带峰：30–70Hz 带内最强尖峰
        持久纯音（工频哼声 / 超低频隆隆声的窄尖）在全曲平均谱上留一根
        窄峰；音乐性低音有起音包络且带泛音列，被时间平均稀释后不会
        在单一频点上这么尖。
        ⚠ 邻域地板必须收窄到 ±3~8 bin。旧写法取 ±16 bin（±173Hz），
          会把 220Hz 音符基频（功率 4e3）算进 50Hz 的「地板」，结果
          干净素材 50Hz 的真峰（0.029）反而低于地板，实测 50Hz 注入
          0.08 正弦后峰功率从 0.029 涨到 5690（20 万倍）却只显出
          9.4× 突出度。地板收窄后同一用例是 5 万倍以上。
        ⚠ 只认低频窄峰，更高次谐波（150/180/240）只做佐证：240Hz 落在
          247Hz 音符基频上，旧写法把它当工频谐波，干净素材直接误报。
        ⚠ 50 与 60Hz 在 4096/44.1k 下只差一个 bin（bin 宽 10.77Hz），
          Hann 主瓣把两者糊在一起。按名义频点各查一次会把 60Hz 的哼声
          记成 50Hz。改成整带扫峰 + 峰位 ±2 bin 质心插值定频：
          50Hz → 50.0Hz，60Hz → 60.3Hz，报实测频率。
        ⚠ 频率要分诊。35Hz 不是电网频率：示例曲里那根 35Hz 的尖是
          「超低频隆隆声」，按「工频哼声」开陷波处方就开错了药。
          45–66Hz 才算工频（50/60Hz 电网），90–135Hz 是整流纹波
          （全波整流把 50/60 抬到 100/120，基频常被滤掉只剩谐波），
          其余是窄带隆隆声——一样下陷波，但名字不能叫错。
        ⚠ 扫描带必须到 135Hz。旧带锁在 30–70Hz，整流纹波只有 120Hz
          一根、基频弱或没有时完全隐身（实测 hum 0.000）。谐波佐证只做
          「加成」且要求基频先过 0.15，救不了「只有谐波」这一类。
        映射：8× → 0，100× → 0.42，3000× → 1.0。8× 以下不作数：
          真实歌曲在 60Hz 上常有 2–3× 的弱尖峰（乐器低音的谱泄漏），
          实测红头绳 prom=3.2×；注入 0.08 的 50Hz 正弦是 12000×。 */
  const binWidth = sampleRate / size;
  const promAtBin = (bC) => {
    if (bC < 3 || bC + 2 >= avgSpectrum.length) return 0;
    // 主瓣：峰位 ±1 bin（Hann 主瓣约 ±2 bin，取最靠近的三个）
    let peakP = 0;
    for (let d = -1; d <= 1; d++) {
      const j = bC + d;
      if (j > 0 && j < avgSpectrum.length) peakP = Math.max(peakP, avgSpectrum[j]);
    }
    if (peakP <= 0) return 0;
    /* 地板 = 局部谱底，取**中位数**而不是均值。
       均值会被窗里的谐波尖拉走：60Hz 的地板窗是 ±10 bin（±107Hz），
       120Hz 的二次谐波只隔 5 bin，正好坐在窗里。实测 60+120 双音时
       120 把均值地板抬了 500 倍，60Hz 突出度从 4254× 塌到 2× ——
       两个真峰互相压死，双双归零。
       中位数对「窗里有几根尖」免疫：16 个样本里 3 根谐波挪不动第 8 名。
       也试过按 k·f 枚举剔谐波——低频谐波在 bin 上挨得太近
       （bC=5 时 1–5 次谐波把 ±10 窗排到只剩 2 个样本），地板直接归零。 */
    const samples = [];
    for (let d = -10; d <= 10; d++) {
      if (Math.abs(d) <= 2) continue;
      const j = bC + d;
      if (j > 1 && j < avgSpectrum.length) samples.push(avgSpectrum[j]);
    }
    if (!samples.length) return peakP > 1e-24 ? 1e6 : 0;
    samples.sort((a, b) => a - b);
    const floorP = samples[samples.length >> 1];
    return floorP > 1e-24 ? peakP / floorP : (peakP > 1e-24 ? 1e6 : 0);
  };
  const promFromBin = (bC) => {
    if (bC < 3 || bC + 2 >= avgSpectrum.length) return 0;
    // bin ±2 内找真峰
    let bP = bC, pP = 0;
    for (let d = -2; d <= 2; d++) {
      const j = bC + d;
      if (j > 0 && j < avgSpectrum.length && avgSpectrum[j] > pP) {
        pP = avgSpectrum[j]; bP = j;
      }
    }
    if (pP <= 0) return 0;
    // 峰位 ±2 bin 质心插值定频
    let num = 0, den = 0;
    for (let j = Math.max(1, bP - 2); j <= Math.min(avgSpectrum.length - 1, bP + 2); j++) {
      num += j * avgSpectrum[j]; den += avgSpectrum[j];
    }
    return {
      prom: promAtBin(bP),
      freq: den > 0 ? Math.round((num / den) * binWidth) : Math.round(bP * binWidth),
      bin: bP,
    };
  };
  // 整带扫峰：30–135Hz 覆盖工频 50/60、超低频隆隆声，以及整流纹波
  // 的 100/120Hz（只有二次谐波、基频被滤掉的那一类）。
  const bLo = Math.max(3, Math.round(30 / binWidth));
  const bHi = Math.min(avgSpectrum.length - 3, Math.round(135 / binWidth));
  let humScore = 0, humFreq = 0, humProminence = 0;
  for (let bC = bLo; bC <= bHi; bC++) {
    const r = promFromBin(bC);
    if (!r || !r.prom) continue;
    // 搜峰 ±2、质心再 ±2，合起来能伸出带外 4 个 bin。180Hz 的泄漏肩
    // 会被 bC=13 抓成「带内峰」并把频率报成 179Hz。峰必须真在带内。
    if (r.bin < bLo || r.bin > bHi) continue;
    const s = r.prom < 8 ? 0
      : clamp((Math.log10(r.prom) - Math.log10(8)) / (Math.log10(3000) - Math.log10(8)), 0, 1);
    if (s > humScore) {
      humScore = s;
      humFreq = r.freq;
      humProminence = r.prom;
    }
  }
  // 谐波佐证：基频已经确认有峰时，2/3 次谐波再各加一点，最多推到 1。
  // 映射与基频同一地板（8× 起算）：不然基频刚过线、三次谐波上一根
  // 3× 的弱尖峰也能白加 0.17。
  if (humScore > 0.15 && humFreq > 0) {
    const h2 = promFromBin(Math.round((humFreq * 2) / binWidth));
    const h3 = promFromBin(Math.round((humFreq * 3) / binWidth));
    const h = Math.max(h2 ? h2.prom : 0, h3 ? h3.prom : 0);
    const boost = h < 8 ? 0
      : clamp((Math.log10(h) - Math.log10(8)) / (Math.log10(3000) - Math.log10(8)), 0, 1) * 0.25;
    humScore = clamp(humScore + boost, 0, 1);
  }

  // 整流纹波常是「50/60 基频 + 100/120 谐波」的链。只报谐波会把陷波
  // 开在 120Hz 而漏掉源头 60Hz。若谐波峰的 f/2 也有真峰，把账记回基频。
  // 纯 120Hz（基频被滤掉）时 f/2 落在地板上（prom<5），不回溯。
  if (humScore > 0.05 && humFreq >= 90 && humFreq <= 135) {
    const fund = promFromBin(Math.round(humFreq / 2 / binWidth));
    if (fund && fund.prom >= 5 && fund.bin >= bLo && fund.bin <= bHi) {
      const sF = fund.prom < 8 ? 0
        : clamp((Math.log10(fund.prom) - Math.log10(8)) / (Math.log10(3000) - Math.log10(8)), 0, 1);
      humFreq = fund.freq;
      humProminence = Math.max(humProminence, fund.prom);
      humScore = clamp(Math.max(humScore, sF + 0.2), 0, 1);
    }
  }
  const mudScore = clamp(Math.max(mudSmear, humScore), 0, 1);
  // 分诊写进指标，UI 只显示不猜：45–66=工频，90–135=整流纹波，其余=窄带峰
  const humKind = humScore <= 0.05 ? 'none'
    : (humFreq >= 45 && humFreq <= 66) ? 'mains'
    : (humFreq >= 90 && humFreq <= 135) ? 'ripple'
    : 'narrowband';

  return {
    rms,
    peak,
    crest: rms > 1e-9 && peak > 0 ? dbFrom(peak / rms) : 0,
    dcOffset: dc,
    lra,
    thd,
    thdCoverage: Math.round(thdCoverage * 100) / 100,
    centroid,
    rolloff,
    flatness,
    lowRatio,
    subRatio,
    mudScore,
    mudSmear: Math.round(mudSmear * 1000) / 1000,
    humScore: Math.round(humScore * 1000) / 1000,
    humFreq,
    humKind,
    humProminence: Math.round(humProminence * 10) / 10,
    spectrum: Array.from(avgSpectrum).map((v) => v / Math.max(specFrames, 1)),
  };
}

  /* ============================================================
     5b. 响度测量与对齐（ITU-R BS.1770-4）
     ------------------------------------------------------------
     「响」和「好听」是两件事：盲听 A/B 里先对齐响度，导出按平台
     LUFS 目标归一，都靠这一个测量。为什么自己算而不用现成库：
     整条链必须零依赖（离线可用），而 K 加权 + 门限积分就 60 行。

     实现要点（全部照标准）：
     · K 加权 = 高架滤波(+4dB @1.68k) + 高通(@38Hz)，RBJ 双二阶；
     · 400ms 块 / 100ms 步进，块内均方 → 块响度；
     * 双门限：先 −70 LUFS 绝对门，再相对门（全体均值 −10 dB），
       门后积分才是 integrated LUFS——安静段落不许拖低整曲。
     · 返回 sample peak（dBFS），对齐/导出时用它守峰值余量。
     ============================================================ */
  function measureLoudness(buffer) {
    const sr = buffer.sampleRate;
    const len = buffer.length;
    const nCh = Math.max(1, buffer.numberOfChannels || 1);
    const blockLen = Math.round(0.4 * sr);
    const hop = Math.round(0.1 * sr);
    if (!len || len < blockLen) return { lufs: null, peakDb: -Infinity, blocks: 0 };

    // ---- K 加权系数（RBJ，参数取 BS.1770-4 标定值）----
    const r10 = (x) => Math.round(x * 1e9) / 1e9;
    const mkShelf = () => {
      const f0 = 1681.9748408, G = 3.999843, Q = 0.70717524;
      const A = Math.pow(10, G / 40);
      const w0 = (2 * Math.PI * f0) / sr;
      const alpha = Math.sin(w0) / (2 * Q);
      const cosw = Math.cos(w0);
      const sqA = Math.sqrt(A);
      const b0 = A * ((A + 1) + (A - 1) * cosw + 2 * sqA * alpha);
      const b1 = -2 * A * ((A - 1) + (A + 1) * cosw);
      const b2 = A * ((A + 1) + (A - 1) * cosw - 2 * sqA * alpha);
      const a0 = (A + 1) - (A - 1) * cosw + 2 * sqA * alpha;
      const a1 = 2 * ((A - 1) - (A + 1) * cosw);
      const a2 = (A + 1) - (A - 1) * cosw - 2 * sqA * alpha;
      return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
    };
    const mkHighpass = () => {
      const f0 = 38.13547087, Q = 0.50032704;
      const w0 = (2 * Math.PI * f0) / sr;
      const alpha = Math.sin(w0) / (2 * Q);
      const cosw = Math.cos(w0);
      const b0 = (1 + cosw) / 2, b1 = -(1 + cosw), b2 = (1 + cosw) / 2;
      const a0 = 1 + alpha, a1 = -2 * cosw, a2 = 1 - alpha;
      return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
    };
    const shelf = mkShelf(), hp = mkHighpass();
    const biquad = (x, c) => {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < x.length; i++) {
        const xn = x[i];
        const yn = c.b0 * xn + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
        x2 = x1; x1 = xn; y2 = y1; y1 = yn;
        x[i] = yn;
      }
    };

    // ---- 滤波（响度走 K 加权）+ 原始真峰值（增益守的是原波形的峰）----
    let peak = 0;
    const filtered = [];
    for (let c = 0; c < nCh; c++) {
      const src = buffer.getChannelData(c);
      const f = new Float64Array(len);
      for (let i = 0; i < len; i++) f[i] = src[i];
      biquad(f, shelf); biquad(f, hp);
      filtered.push(f);
      for (let i = 0; i < len; i++) {
        const a = src[i] < 0 ? -src[i] : src[i];
        if (a > peak) peak = a;
      }
    }

    // ---- 块均方 → 块响度 ----
    const nBlocks = Math.floor((len - blockLen) / hop) + 1;
    if (nBlocks < 1) return { lufs: null, peakDb: r10(20 * Math.log10(Math.max(peak, 1e-9))), blocks: 0 };
    const blockL = new Float64Array(nBlocks);
    const blockSum = new Float64Array(nBlocks); // 各通道均方之和（G=1）
    for (let bi = 0; bi < nBlocks; bi++) {
      const off = bi * hop;
      let s = 0;
      for (let c = 0; c < nCh; c++) {
        const f = filtered[c];
        let acc = 0;
        for (let i = off; i < off + blockLen; i++) acc += f[i] * f[i];
        s += acc / blockLen;
      }
      blockSum[bi] = s;
      blockL[bi] = -0.691 + 10 * Math.log10(Math.max(s, 1e-12));
    }

    // ---- 双门限 ----
    const meanOf = (idx) => {
      let s = 0, n = 0;
      for (const i of idx) { s += blockSum[i]; n++; }
      return n ? s / n : 0;
    };
    const absIdx = [];
    for (let bi = 0; bi < nBlocks; bi++) if (blockL[bi] > -70) absIdx.push(bi);
    if (!absIdx.length) return { lufs: null, peakDb: r10(20 * Math.log10(Math.max(peak, 1e-9))), blocks: nBlocks };
    const relGate = -0.691 + 10 * Math.log10(Math.max(meanOf(absIdx), 1e-12)) - 10;
    const finalIdx = absIdx.filter((i) => blockL[i] > Math.max(-70, relGate));
    if (!finalIdx.length) return { lufs: null, peakDb: r10(20 * Math.log10(Math.max(peak, 1e-9))), blocks: nBlocks };
    const lufs = -0.691 + 10 * Math.log10(Math.max(meanOf(finalIdx), 1e-12));
    return {
      lufs: Math.round(lufs * 10) / 10,
      peakDb: r10(20 * Math.log10(Math.max(peak, 1e-9))),
      blocks: nBlocks,
      gate: Math.round(relGate * 10) / 10,
    };
  }

  /* ============================================================
     短时响度曲线（EBU R128 短时口径）：K 加权后 3 秒窗 / 0.25 秒步进
     滑动取均方 → LUFS。与 measureLoudness 的双门限积分是两个口径：
     这里不做门限，安静段落如实压低，画图侧负责裁显示地板。
     K 加权系数与 measureLoudness 完全一致（BS.1770-4 标定值）——
     两处各自独立持有，改标定参数请两处同步。
     纯函数，鸭子类型 buffer（getChannelData），Node 可直接单测。
     ============================================================ */
  function loudnessCurve(buffer, opts) {
    const o = opts || {};
    const sr = buffer.sampleRate;
    const len = buffer.length;
    const nCh = Math.max(1, buffer.numberOfChannels || 1);
    const winSec = o.windowSec > 0 ? o.windowSec : 3;
    const hopSec = o.hopSec > 0 ? o.hopSec : 0.25;
    const empty = {
      times: new Float64Array(0), lufs: new Float64Array(0),
      windowSec: winSec, hopSec,
    };
    if (!sr || !len) return empty;
    const win = Math.min(Math.round(winSec * sr), len);
    const hop = Math.max(1, Math.round(hopSec * sr));
    if (win < Math.round(0.05 * sr)) return empty;

    // ---- K 加权系数（RBJ，参数取 BS.1770-4 标定值，同 measureLoudness）----
    const mkShelf = () => {
      const f0 = 1681.9748408, G = 3.999843, Q = 0.70717524;
      const A = Math.pow(10, G / 40);
      const w0 = (2 * Math.PI * f0) / sr;
      const alpha = Math.sin(w0) / (2 * Q);
      const cosw = Math.cos(w0);
      const sqA = Math.sqrt(A);
      const b0 = A * ((A + 1) + (A - 1) * cosw + 2 * sqA * alpha);
      const b1 = -2 * A * ((A - 1) + (A + 1) * cosw);
      const b2 = A * ((A + 1) + (A - 1) * cosw - 2 * sqA * alpha);
      const a0 = (A + 1) - (A - 1) * cosw + 2 * sqA * alpha;
      const a1 = 2 * ((A - 1) - (A + 1) * cosw);
      const a2 = (A + 1) - (A - 1) * cosw - 2 * sqA * alpha;
      return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
    };
    const mkHighpass = () => {
      const f0 = 38.13547087, Q = 0.50032704;
      const w0 = (2 * Math.PI * f0) / sr;
      const alpha = Math.sin(w0) / (2 * Q);
      const cosw = Math.cos(w0);
      const b0 = (1 + cosw) / 2, b1 = -(1 + cosw), b2 = (1 + cosw) / 2;
      const a0 = 1 + alpha, a1 = -2 * cosw, a2 = 1 - alpha;
      return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
    };
    const shelf = mkShelf(), hp = mkHighpass();
    const biquad = (x, c) => {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < x.length; i++) {
        const xn = x[i];
        const yn = c.b0 * xn + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
        x2 = x1; x1 = xn; y2 = y1; y1 = yn;
        x[i] = yn;
      }
    };

    // ---- 逐通道滤波，边滤边累加平方和前缀（窗口均方 O(1) 取）----
    const pre = new Float64Array(len + 1);
    const scratch = new Float64Array(len);
    for (let c = 0; c < nCh; c++) {
      const src = buffer.getChannelData(c);
      for (let i = 0; i < len; i++) scratch[i] = src[i];
      biquad(scratch, shelf); biquad(scratch, hp);
      let acc = 0;
      for (let i = 0; i < len; i++) {
        acc += scratch[i] * scratch[i];
        pre[i + 1] += acc;          // 多声道：各通道的运行和累加进同一前缀
      }
    }

    // ---- 滑窗取点：时间戳记窗口中心 ----
    const nPts = Math.floor((len - win) / hop) + 1;
    const times = new Float64Array(nPts);
    const lufs = new Float64Array(nPts);
    for (let k = 0; k < nPts; k++) {
      const s = k * hop;
      const ms = (pre[s + win] - pre[s]) / win;
      times[k] = (s + win / 2) / sr;
      lufs[k] = -0.691 + 10 * Math.log10(Math.max(ms, 1e-12));
    }
    return { times, lufs, windowSec: win / sr, hopSec: hop / sr };
  }

  /* 把 buffer 复制成同规格的可写对象。浏览器用 AudioBuffer，
     Node 单测没有 AudioBuffer —— 退回鸭子类型同构对象，不引依赖。 */
  function copyBuffer(buffer) {
    const len = buffer.length, nCh = buffer.numberOfChannels, sr = buffer.sampleRate;
    if (typeof AudioBuffer !== 'undefined') {
      const out = new AudioBuffer({ length: len, numberOfChannels: nCh, sampleRate: sr });
      for (let c = 0; c < nCh; c++) out.getChannelData(c).set(buffer.getChannelData(c));
      return out;
    }
    const data = [];
    for (let c = 0; c < nCh; c++) {
      const f = new Float32Array(len);
      f.set(buffer.getChannelData(c));
      data.push(f);
    }
    return {
      sampleRate: sr, numberOfChannels: nCh, length: len, duration: len / sr,
      getChannelData: (c) => data[c],
    };
  }

  /**
   * 把响度搬到目标值上（导出用），峰值先让路：
   * 增益后若会顶过 peakCeil（默认 −1 dBFS），就只增到峰值线上。
   * 常数增益不改变频响与动态，limit 标记如实上报「目标没到」。
   */
  function matchLoudness(buffer, targetLufs, peakCeilDb) {
    const ceil = peakCeilDb != null ? peakCeilDb : -1;
    const before = measureLoudness(buffer);
    const bail = (gain, limited) => ({
      buffer, before, after: before, gain: Math.round(gain * 10) / 10,
      limited, target: targetLufs,
    });
    if (before.lufs == null) return bail(0, false);
    let gainDb = targetLufs - before.lufs;
    let limited = false;
    if (before.peakDb + gainDb > ceil) { gainDb = ceil - before.peakDb; limited = true; }
    if (Math.abs(gainDb) < 0.05) return bail(gainDb, limited);
    const g = Math.pow(10, gainDb / 20);
    const out = copyBuffer(buffer);
    for (let c = 0; c < out.numberOfChannels; c++) {
      const d = out.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= g;
    }
    const after = measureLoudness(out);
    return { buffer: out, before, after, gain: Math.round(gainDb * 10) / 10, limited, target: targetLufs };
  }

  /* ============================================================
     6. 结构划分（能量新颖度）
     ============================================================ */
function detectStructure(data, sampleRate, duration, bpm) {
    // clamp 内联：splice 只搬函数体
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  
    /* ---- 1. 内容特征：每 2s 一帧 ----
       帧内叠 nSub 个 win 点 FFT 平均，池成 nBand 条对数频带。
       2s 的窗足以把伯努利漏拍噪声压下去，又比最短段（约 20s）细得多。 */
    const hopSec = 2.0;
    const win = 2048;
    const nSub = 8;
    const nBand = 24;
    const nFrames = Math.max(1, Math.floor(duration / hopSec));
    const hop = Math.max(1, Math.floor(hopSec * sampleRate));
  
    // 频带边界：60Hz 起对数分布到 Nyquist 的 95%
    const fMax = Math.min(8000, (sampleRate / 2) * 0.95);
    const fMin = 60;
    const edges = [];
    for (let b = 0; b <= nBand; b++) edges.push(fMin * Math.pow(fMax / fMin, b / nBand));
    const binOf = (freq) => Math.round((freq * win) / sampleRate);
    const binBand = new Int32Array(win >> 1);
    binBand.fill(-1);
    for (let b = 0; b < nBand; b++) {
      const lo = Math.max(1, binOf(edges[b]));
      const hi = Math.min((win >> 1) - 1, binOf(edges[b + 1]));
      for (let i = lo; i <= hi; i++) if (binBand[i] < 0) binBand[i] = b;
    }
  
    const window = hann(win);
    const frames = [];
    for (let f = 0; f < nFrames; f++) {
      const bands = new Float64Array(nBand);
      const t0 = Math.floor(f * hop);
      let used = 0;
      for (let s = 0; s < nSub; s++) {
        const off = t0 + Math.floor((s * hop) / nSub);
        if (off + win >= data.length && off >= data.length) break;
        const mag = frameSpectrum(data, off, win, window);
        used++;
        for (let i = 1; i < mag.length && i < binBand.length; i++) {
          const b = binBand[i];
          if (b >= 0) bands[b] += mag[i] * mag[i];
        }
      }
      if (!used) { frames.push(null); continue; }
      // 对数压缩 + 去均值 + L2 归一：比的是音色形状，不是响度
      let sum = 0;
      const v = new Float64Array(nBand);
      for (let b = 0; b < nBand; b++) {
        v[b] = Math.log(bands[b] / used + 1e-12);
        sum += v[b];
      }
      const mean = sum / nBand;
      let nrm = 0;
      for (let b = 0; b < nBand; b++) { v[b] -= mean; nrm += v[b] * v[b]; }
      nrm = Math.sqrt(nrm) || 1;
      for (let b = 0; b < nBand; b++) v[b] /= nrm;
      frames.push(v);
    }
  
    // 极短曲：如实报能量，别硬填 1（旧版 <6s 回 energy:1，静音也满格）
    let eSum = 0, eCnt = 0, eMax = 0;
    for (let i = 0; i < data.length; i++) {
      const x = data[i] * data[i];
      eSum += x; eCnt++;
      if (x > eMax) eMax = x;
    }
    const rmsAll = eCnt ? Math.sqrt(eSum / eCnt) : 0;
    const peakAll = Math.sqrt(eMax);
    const normE = peakAll > 0 ? clamp(rmsAll / (peakAll * 0.5), 0, 1) : 0;
    if (nFrames < 3 || duration < 6) {
      return [{ section: 'full', start: 0, end: duration, energy: Math.round(normE * 1000) / 1000 }];
    }
  
    /* ---- 2. 自相似矩阵 ---- */
    const S = [];
    for (let i = 0; i < nFrames; i++) {
      S.push(new Float64Array(nFrames));
      if (!frames[i]) continue;
      for (let j = 0; j <= i; j++) {
        if (!frames[j]) { S[i][j] = 0; S[j][i] = 0; continue; }
        let d = 0;
        for (let b = 0; b < nBand; b++) d += frames[i][b] * frames[j][b];
        S[i][j] = d; S[j][i] = d;
      }
    }
  
    /* ---- 3. Foote 棋盘核新颖度 ----
       跨界对（左窗 × 右窗）相似度低 且 同侧对相似度高 → 这里是边界。
       对「慢慢变响」的段落切换也有效，因为比的是音色形状不是绝对能量。
       ⚠ 只取**非对角**对。旧写法 within 里带 a==b 的对角项 S[i±a][i±a]，
         对 L2 归一向量恒等于 1.0，8 个项里占了 4 个 —— 于是新颖度处处
         被抬高 0.04 量级，真边界被淹没在假峰里（96s 实测真边界 12.5s
         的峰跑到 8s 去了）。 */
    const K = 3;
    const novelty = new Float64Array(nFrames);
    for (let i = K; i < nFrames - K; i++) {
      let within = 0, wc = 0, across = 0, ac = 0;
      for (let a = 1; a <= K; a++) {
        for (let b = a + 1; b <= K; b++) {
          within += S[i - a][i - b] + S[i + a][i + b]; wc += 2;
        }
        for (let b = 1; b <= K; b++) {
          across += S[i - a][i + b]; ac++;
        }
      }
      novelty[i] = (wc ? within / wc : 0) - (ac ? across / ac : 0);
    }
    // 头尾补平
    for (let i = 0; i < K; i++) { novelty[i] = novelty[K] || 0; novelty[nFrames - 1 - i] = novelty[nFrames - 1 - K] || 0; }
  
    const nMean = novelty.reduce((a, b) => a + b, 0) / novelty.length;
    const nSd = Math.sqrt(novelty.reduce((a, b) => a + (b - nMean) * (b - nMean), 0) / novelty.length) || 1;
    const thresh = nMean + nSd * 0.35;
  
    const barSec = bpm > 30 ? (4 * 60) / bpm : 2.6;
    // 最短段：约 4 小节，夹在 6–22s 之间 → 换算成帧数
    const minSeg = Math.max(3, Math.round(clamp(barSec * 4, 6, 22) / hopSec));
    // 最多几段：按最短段推，但要给 intro/outro 这种短段留位置。
    // 旧写法 round(duration/22) 在 96s 上锁死 4 段，而真曲式是 5 段
    // （intro 12.5s 就短于 22s）—— 直接把 intro+A 并掉了。
    const maxSeg = clamp(Math.ceil(nFrames / minSeg) + 1, 3, 8);
  
    /* ---- 3b. 长窗验证：边界必须「持续不同」，6s 尺度的峰不算数 ----
       K=3 的棋盘核只比 ±6s：平稳纹理的随机起伏（每帧随机音高/密度）
       在 6s 尺度上也会造出 within−across 的假峰 —— 80s 单段渐强实测
       最高 0.036 的假峰（3.6σ），与真边界同量级，纯统计阈值分不开。
       真段落切换是「两个内部一致的大块彼此不同」：把窗拉到 ±8 帧
       （16s，接近最短段）后差异仍在，才算边界；纹理噪声的假峰会被
       长窗平均掉（同一 80s 素材实测 drop 从 0.036 掉到 ≈0）。
       门槛取 0.01（有曲式素材实测长窗 drop ≥ 0.020，纹理假峰 ≤ 0.002）
       且至少保留 6s 峰值的 1/4（防「长窗噪声刚过线」）。 */
    const longDrop = (i) => {
      const K2 = Math.max(2, Math.min(8, i - 1, nFrames - 1 - i));
      let within = 0, wc = 0, across = 0, ac = 0;
      for (let a = 1; a <= K2; a++) {
        for (let b = a + 1; b <= K2; b++) {
          within += S[i - a][i - b] + S[i + a][i + b]; wc += 2;
        }
        for (let b = 1; b <= K2; b++) {
          across += S[i - a][i + b]; ac++;
        }
      }
      return (wc ? within / wc : 0) - (ac ? across / ac : 0);
    };
    const cands = [];
    for (let i = 1; i < nFrames - 1; i++) {
      if (!(novelty[i] >= thresh && novelty[i] >= novelty[i - 1] && novelty[i] > novelty[i + 1])) continue;
      const ld = longDrop(i);
      if (ld >= 0.01 && ld >= 0.25 * novelty[i]) cands.push({ i, w: novelty[i] });
    }
    cands.sort((a, b) => b.w - a.w);
    const bounds = [0];
    for (const c of cands) {
      if (bounds.length - 1 >= maxSeg - 1) break;
      if (bounds.some((b) => Math.abs(b - c.i) < minSeg)) continue;
      bounds.push(c.i);
    }
    bounds.sort((a, b) => a - b);
    bounds.push(nFrames);
    for (let i = 1; i < bounds.length - 1; ) {
      if (bounds[i + 1] - bounds[i] < minSeg && bounds.length > 3) bounds.splice(i, 1);
      else i++;
    }
  
    /* ---- 4. 段特征：平均能量 + 段间相似度 ---- */
    const energyOf = (start, end) => {
      const i0 = Math.floor(start * sampleRate);
      const i1 = Math.min(data.length, Math.floor(end * sampleRate));
      let acc = 0, c = 0;
      for (let k = i0; k < i1; k += 8) { acc += data[k] * data[k]; c++; }
      const rms = c ? Math.sqrt(acc / c) : 0;
      return peakAll > 0 ? clamp(rms / (peakAll * 0.5), 0, 1) : 0;
    };
    const segs = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const a = bounds[i], b = bounds[i + 1];
      const start = Math.round(a * hopSec * 10) / 10;
      const end = Math.round(Math.min(b * hopSec, duration) * 10) / 10;
      segs.push({ start, end, energy: energyOf(start, end) });
    }
  
    const peakE = Math.max(...segs.map((s) => s.energy), 0.0001);
    const quiet = (s) => s.energy <= peakE * 0.62;
  
    /* ---- 4b. 相邻安静段先并掉 ----
       内容向量是去均值 + L2 归一的，能量被刻意抹掉（好让「同一段内容」
       不受响度影响）。代价是安静的尾奏能和响亮的主歌在音色上撞车：
       140s 实测尾奏 116→128 被判成 'A'，于是尾奏多出一条边界。
       与其去拧相似度阈值，不如承认：**两段都安静还挨着，它们之间
       就不该有边界**——那是尾奏/前奏内部的噪声起伏，不是曲式。 */
    for (let i = 0; i < segs.length - 1; ) {
      if (quiet(segs[i]) && quiet(segs[i + 1])) {
        const span = segs[i + 1].end - segs[i].start;
        segs[i].energy = span > 0
          ? (segs[i].energy * (segs[i].end - segs[i].start)
           + segs[i + 1].energy * (segs[i + 1].end - segs[i + 1].start)) / span
          : segs[i].energy;
        segs[i].end = segs[i + 1].end;
        segs.splice(i + 1, 1);
      } else i++;
    }
  
    // 段间内容相似度：跨段帧对的平均 cos
    for (const s of segs) {
      s.i0 = Math.max(0, Math.round(s.start / hopSec));
      s.i1 = Math.min(nFrames, Math.round(s.end / hopSec));
      if (s.i1 <= s.i0) s.i1 = s.i0 + 1;
    }
    const segSim = (A, B) => {
      let acc = 0, c = 0;
      for (let i = A.i0; i < A.i1; i++) {
        if (!frames[i]) continue;
        for (let j = B.i0; j < B.i1; j++) {
          if (!frames[j]) continue;
          acc += S[i][j]; c++;
        }
      }
      return c ? acc / c : 0;
    };
    // 段内自相似（排除对角）= 「这段自己有多一致」
    const withinSim = segs.map((A) => {
      let acc = 0, c = 0;
      for (let i = A.i0; i < A.i1; i++) {
        if (!frames[i]) continue;
        for (let j = A.i0; j < A.i1; j++) {
          if (i === j || !frames[j]) continue;
          acc += S[i][j]; c++;
        }
      }
      return c ? acc / c : 1;
    });
  
    /* ---- 5. 按内容命名 ----
       字母 = 内容身份。首尾低能 = intro/outro；其余首次出现给 A，
       段间相似度足够高就复用字母（主歌再现），否则给新字母。
       响度/能量排名一律不影响命名——但两段能量差太多就不可能是同一段
       （主歌再现在同一首里能量是接近的），这条只挡「安静撞响亮」的误配。 */
    // 「同一段内容」：能量接近 且 跨段相似度达到两者自身一致度的 72%
    const sameContent = (i, j) => {
      if (Math.abs(segs[i].energy - segs[j].energy) > 0.18) return false;
      const s = segSim(segs[i], segs[j]);
      return s >= 0.72 * Math.min(withinSim[i], withinSim[j]);
    };
  
    const usedLetters = [];
    const nextLetter = () => {
      const L = ['A', 'B', 'D', 'E', 'F', 'G'];
      for (const l of L) if (!usedLetters.includes(l)) { usedLetters.push(l); return l; }
      return 'B';
    };
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      let section;
      const isFirst = i === 0, isLast = i === segs.length - 1;
      if (segs.length === 1) section = 'full';
      else if (isFirst && quiet(s)) section = 'intro';
      else if (isLast && quiet(s) && segs.length > 2) section = 'outro';
      else {
        // 只跟不相邻的已命名段比：相邻两段本来就是被边界切开的
        let twin = null;
        for (let j = 0; j < i - 1; j++) {
          if (out[j].section.length !== 1) continue;
          if (sameContent(i, j)) { twin = out[j].section; break; }
        }
        section = twin || nextLetter();
      }
      out.push({
        section,
        start: s.start,
        end: s.end,
        energy: Math.round(s.energy * 1000) / 1000,
      });
    }
    if (out.length === 2) {
      out[0].section = quiet(segs[0]) ? 'intro' : 'A';
      out[1].section = quiet(segs[1]) ? 'outro' : (out[0].section === 'A' ? 'B' : 'A');
    }
  
    /* ---- 6. 合并相邻同名段 ----
       内容聚类说两段是同一段（同一个字母），那它们之间就不该有边界。
       140s 实测：尾奏被多切一刀，两半都被判成 'A'（80→116 · 116→128），
       结果曲式多出一段。与其去调峰阈值（会误伤 96s 的 12.5s 短前奏），
       不如让「内容相同」直接判定边界无效——这是聚类自己的结论。
       intro/outro 是位置标签不是内容标签，不参与合并。 */
    const merged = [];
    for (const s of out) {
      const prev = merged[merged.length - 1];
      if (prev && prev.section === s.section && s.section.length === 1) {
        const span = (prev.end - prev.start) + (s.end - s.start);
        prev.energy = span > 0
          ? Math.round(((prev.energy * (prev.end - prev.start) + s.energy * (s.end - s.start)) / span) * 1000) / 1000
          : prev.energy;
        prev.end = s.end;
      } else {
        merged.push(s);
      }
    }
    return merged;
  }

  /* ============================================================
     7. 旋律基因
     ============================================================ */
function melodyGenome(data, sampleRate, chroma) {
    // 短时主导音高轨迹（MIDI，不是音级）→ 旋律轮廓 + 时值序列
    const win = 4096, hop = 4096;
    const window = hann(win);
    const midiSeq = [];      // 每 hop 一帧的 MIDI 音高（无声帧记 null）
    for (let off = 0; off + win < data.length; off += hop) {
      const mag = frameSpectrum(data, off, win, window);
      let eSum = 0;
      for (let i = 1; i < mag.length; i++) eSum += mag[i] * mag[i];
      if (eSum < 1e-10) { midiSeq.push(null); continue; }
      // 只在旋律音区找峰，避开低频能量堆
      let bestI = -1, bestV = 0;
      const hi = Math.min(mag.length - 2, Math.floor((2200 * win) / sampleRate));
      const lo = Math.max(2, Math.ceil((80 * win) / sampleRate));
      for (let i = lo; i <= hi; i++) {
        if (mag[i] > bestV && mag[i] > mag[i - 1] && mag[i] >= mag[i + 1]) {
          bestV = mag[i]; bestI = i;
        }
      }
      if (bestI < 0 || bestV < 1e-7) { midiSeq.push(null); continue; }
      const f = (bestI * sampleRate) / win;
      // 显著性：峰要明显高于频带中位数，否则不算可靠音高
      let sum = 0, cnt = 0;
      for (let i = lo; i <= hi; i++) { sum += mag[i]; cnt++; }
      const meanV = cnt ? sum / cnt : 0;
      midiSeq.push(bestV > meanV * 2.2 ? 69 + 12 * Math.log2(Math.max(f, 1) / 440) : null);
    }
  
    // 音符化：相邻同音高合并，掉电平/静音打断
    const notes = [];        // {midi, frames}
    let cur = null;
    for (const m of midiSeq) {
      if (m == null) { if (cur) { notes.push(cur); cur = null; } continue; }
      const q = Math.round(m);
      if (cur && Math.abs(q - cur.midi) <= 0.7) { cur.midi = (cur.midi * cur.frames + q) / (cur.frames + 1); cur.frames++; }
      else { if (cur) notes.push(cur); cur = { midi: q, frames: 1 }; }
    }
    if (cur) notes.push(cur);
  
    // 只留有持续性的音（≥3 帧 ≈ 280ms），滤掉频谱瞬时跳动
    const stable = notes.filter((n) => n.frames >= 3);
    const src = stable.length >= 6 ? stable : notes;
  
    /* ---- 稳健音域：极值统计量就该用极值 ----
       5–95 百分位把 19 半音削成 13、24 削成 17（实测），
       因为音域的两端往往只有一两个音，正好落在被截掉的 5% 里。
       只剔「孤岛」——离中位数远、且 5 半音内没有第二个音的点。 */
    const sortedMidi = src.map((n) => Math.round(n.midi)).sort((a, b) => a - b);
    const rangeSemitones = (() => {
      const n = sortedMidi.length;
      if (n < 2) return 0;
      const med = sortedMidi[Math.floor(n / 2)];
      const isIsolated = (i) => {
        const v = sortedMidi[i];
        if (Math.abs(v - med) < 8) return false;   // 靠近中位数 = 旋律本体
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          if (Math.abs(sortedMidi[j] - v) <= 5) return false;
        }
        return true;
      };
      let lo = 0, hi = n - 1;
      while (lo < hi && isIsolated(lo)) lo++;
      while (hi > lo && isIsolated(hi)) hi--;
      return sortedMidi[hi] - sortedMidi[lo];
    })();
  
    // 轮廓：等距抽样全序列，不截断前 96 个
    const contourFull = src.map((n) => Math.round(n.midi));
    const rhythmFull = src.map((n) => n.frames);
    const fit = (arr, n = 96) => {
      if (arr.length <= n) return arr.slice();
      const out = [];
      for (let i = 0; i < n; i++) out.push(arr[Math.floor((i * arr.length) / n)]);
      return out;
    };
    // 音程方向序列（−1/0/+1），比绝对音高更适合跨曲比较
    const direction = [];
    for (let i = 1; i < contourFull.length; i++) {
      const d = contourFull[i] - contourFull[i - 1];
      direction.push(d > 0.6 ? 1 : d < -0.6 ? -1 : 0);
    }
  
    /* ---- 节奏 n-gram：时值二元组直方图 ----
       旧版把「时值序列」塞进 rhythmNgram，字段名说谎。
       真 n-gram = 量化时值的相邻对计数，这才是可跨曲比较的节奏指纹。 */
    const rhythmNgram = (() => {
      // 量化到 2/3/4/6/8/12/16 帧（hop=4096 ≈ 93ms 的倍数），其余归 'x'
      const BUCKETS = [2, 3, 4, 6, 8, 12, 16];
      const label = (frames) => {
        let best = 'x', bestD = Infinity;
        for (const b of BUCKETS) {
          const d = Math.abs(frames - b);
          if (d < bestD) { bestD = d; best = String(b); }
        }
        return bestD <= 2 ? best : 'x';
      };
      const hist = new Map();
      for (let i = 1; i < rhythmFull.length; i++) {
        const key = label(rhythmFull[i - 1]) + '>' + label(rhythmFull[i]);
        hist.set(key, (hist.get(key) || 0) + 1);
      }
      return [...hist.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 16)
        .map(([gram, count]) => ({ gram, count }));
    })();
  
    // 调性清晰度：五声音级占能量比
    const sorted = [...chroma].sort((a, b) => b - a);
    const top5 = sorted.slice(0, 5).reduce((a, b) => a + b, 0);
    const tonalness = clamp(top5, 0, 1);

    /* 记谱事件流：完整音符+休止的原始帧序列。
       contour/rhythm 是 96 点等距抽样摘要（跨曲比较用），时值与静音都丢，
       拿它们记谱会缺音错位；scoreEvents 不抽样不滤帧，带 k:'r' 休止段，
       buildScore 的唯一数据源。 */
    const scoreEvents = (() => {
      const out = [];
      let sil = 0;
      for (const m of midiSeq) {
        if (m == null) { sil++; continue; }
        const q = Math.round(m);
        const last = out.length ? out[out.length - 1] : null;
        if (last && last.k === 'n' && sil === 0 && Math.abs(q - last.midi) <= 0.7) {
          last.midi = (last.midi * last.frames + q) / (last.frames + 1);
          last.frames++;
        } else {
          if (sil > 0) { out.push({ k: 'r', frames: sil }); sil = 0; }
          out.push({ k: 'n', midi: q, frames: 1 });
        }
      }
      return out;
    })();

    return {
      // method 说明白这不是旋律转写，而是「主导音高轨迹」——复音混音里做不了真正的旋律抽取
      method: 'dominant-partial-trajectory',
      note: '复音混音无单一旋律线；此为短时主导音高轨迹，非旋律转写。',
      pitchClassHist: Array.from(chroma).map((v) => Math.round(v * 1000) / 1000),
      contour: fit(contourFull),
      direction: fit(direction),
      rhythm: fit(rhythmFull),
      rhythmNgram,
      scoreEvents,
      noteCount: src.length,
      rangeSemitones,
      tonalness,
    };
  }

  /* ============================================================
     记谱量化：scoreEvents（帧流）→ 1/16 栅格谱面事件
     ------------------------------------------------------------
     · 只对 onset 四舍五入到 1/16 拍，时值取相邻事件之差（含休止），
       小节对齐天然不漂；量纲 = 十六分音符的个数（4/4 一小节 16）。
     · 相邻同音高、无缝的音合并——提取链的碎音在此收束，谱面才可读。
     · 拍号缺/弱按 4/4 兜底，与 UI「未定 · 按 4/4」同一口径。
     · 纯函数：events + {bpm, meter, secPerFrame} → 谱面模型。
     ============================================================ */
  function buildScore(events, opts) {
    const o = opts || {};
    const bpm = o.bpm > 0 ? o.bpm : 90;
    const spf = o.secPerFrame > 0 ? o.secPerFrame : 4096 / (o.sampleRate || 44100);
    const meter = /^\d+\/\d+$/.test(o.meter || '') ? o.meter : '4/4';
    const num = parseInt(meter.split('/')[0], 10);
    const den = parseInt(meter.split('/')[1], 10);
    const gridPerBar = Math.round((num * 16) / den);   // 4/4→16 · 6/8→12 · 3/4→12
    const beatSec = 60 / bpm;

    const items = [];       // {k:'n'|'r', midi?, start, dur}  单位 = 1/16 拍
    let tSec = 0, lastEnd = 0;
    for (const e of (events || [])) {
      const dSec = e.frames * spf;
      const naturalStart = Math.round((tSec / beatSec) * 4);
      const naturalEnd = Math.round(((tSec + dSec) / beatSec) * 4);
      tSec += dSec;
      const isNote = e.k === 'n';
      const start = Math.max(lastEnd, naturalStart);
      const dur = isNote
        ? Math.max(1, naturalEnd - start)
        : Math.max(0, naturalEnd - start);
      if (dur <= 0) continue;
      items.push(isNote ? { k: 'n', midi: Math.round(e.midi), start, dur } : { k: 'r', start, dur });
      lastEnd = start + dur;
    }

    // 合并相邻同音高无缝音（量化后边界重合的同音）
    const merged = [];
    for (const it of items) {
      const prev = merged[merged.length - 1];
      if (prev && prev.k === 'n' && it.k === 'n' && prev.midi === it.midi &&
          prev.start + prev.dur === it.start) {
        prev.dur += it.dur;
      } else {
        merged.push(it);
      }
    }

    const end = merged.length ? merged[merged.length - 1].start + merged[merged.length - 1].dur : 0;
    const bars = Math.max(1, Math.ceil(end / gridPerBar));
    return {
      bpm, meter, num, den, gridPerBar, bars,
      units: bars * gridPerBar,
      items: merged,
      noteCount: merged.reduce((n, it) => n + (it.k === 'n' ? 1 : 0), 0),
    };
  }

  /* ============================================================
     7a. 同旋律 × 五调式互转（宫系统内换主音）
     ------------------------------------------------------------
     音集合不变，只换「哪一级当主音」——这是五声调式互转和西洋转调
     的根本区别：
       音级 k 在源调式里是第 (k − srcDeg) 级，换到目标主音位置 t 后
       落在第 ((k − srcDeg) + t) mod 5 级，取其新音级的最近八度。
     · srcDeg === t 时恒等（逐音可证），试听原旋律按钮天然安全；
     · 集合外的偏音（4/1/0 等）原样保留——互转不发明音；
     * 纯函数，Node 可直接单测。
     ============================================================ */
  function transposeMelodyToMode(melody, gongIndex, degIndex, targetDeg) {
    if (!melody || !melody.contour || !melody.contour.length) return null;
    if (gongIndex == null || degIndex == null) return null;
    const set = PENTA_STEPS.map((st) => (((gongIndex % 12) + st) % 12 + 12) % 12);
    const contour = melody.contour.map((m) => {
      const pc = ((Math.round(m) % 12) + 12) % 12;
      const k = set.indexOf(pc);
      if (k < 0) return Math.round(m); // 集合外的音原样过
      const d = (((k - degIndex) % 5) + 5) % 5;
      const newPc = set[(((d + targetDeg) % 5) + 5) % 5];
      // 最近八度：直接四舍五入到离原音最近的那份，不做有限范围搜索——
      // 固定 o 区间在 MIDI 高位（69→71 这类）会漏掉正确八度。
      return newPc + 12 * Math.round((m - newPc) / 12);
    });
    return Object.assign({}, melody, { contour });
  }

  /* ============================================================
     7b. 旋律基因试听渲染（离线合成，给互转预览用）
     ------------------------------------------------------------
     rhythm 帧的时长换算必须传 secPerFrame（= 分析 hop / 分析采样率），
     与 melodyGenome 的索引公式一一对应，否则节奏会整体错速。
     ============================================================ */
  async function renderMelodyPreview(contour, rhythm, secPerFrame, opts) {
    const o = opts || {};
    const sr = o.sampleRate || 44100;
    const gain = o.gain != null ? o.gain : 0.55;
    const spf = secPerFrame > 0 ? secPerFrame : 4096 / sr;
    const n = Math.min(contour.length, rhythm.length);
    if (!n) return null;
    const times = new Float64Array(n);
    const durs = new Float64Array(n);
    let cursor = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.max(0.05, (rhythm[i] || 3) * spf);
      times[i] = cursor;
      durs[i] = Math.max(0.06, d * 0.92);
      cursor += d;
    }
    const len = Math.ceil((cursor + 0.25) * sr);
    const ctx = new OfflineAudioContext(1, len, sr);
    const master = ctx.createGain();
    master.gain.value = gain;
    master.connect(ctx.destination);
    const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
    for (let i = 0; i < n; i++) {
      const t = times[i], dur = durs[i];
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = midiToHz(contour[i]);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.9, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(lp); lp.connect(g); g.connect(master);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
    return await ctx.startRendering();
  }

  /* ============================================================
     8. 主入口：分析 → 音乐档案
     ============================================================ */
  function analyze(buffer) {
    const sr = buffer.sampleRate;
    // 分析用**全声道等权单声道混合**。旧代码只取 getChannelData(0)，
    // 立体声素材按左声道单边分析——只写在右声道里的内容会被整段漏掉。
    const nCh = Math.max(1, buffer.numberOfChannels || 1);
    const data = (() => {
      if (nCh === 1) {
        const ch0 = buffer.getChannelData(0);
        return ch0.length ? ch0 : new Float32Array(1);
      }
      const len = buffer.length || 1;
      const out = new Float32Array(len);
      for (let c = 0; c < nCh; c++) {
        const ch = buffer.getChannelData(c);
        for (let i = 0; i < len; i++) out[i] += ch[i];
      }
      const inv = 1 / nCh;
      for (let i = 0; i < len; i++) out[i] *= inv;
      return out;
    })();

    // 全曲平均色度
    const size = 4096, window = hann(size), hop = 2048;
    const chromaAcc = new Float64Array(12);
    let fcount = 0;
    for (let off = 0; off + size < data.length; off += hop) {
      const mag = frameSpectrum(data, off, size, window);
      const c = chromaFromSpectrum(mag, sr, size);
      for (let i = 0; i < 12; i++) chromaAcc[i] += c[i];
      fcount++;
    }
    const chroma = new Float64Array(12);
    if (fcount > 0) for (let i = 0; i < 12; i++) chroma[i] = chromaAcc[i] / fcount;

    const mode = detectMode(chroma);
    // 定不出主音就不标大/小调 —— rootIndex 在兜底分支里是 0，会假装 C 大调
    const tonality = mode.root === '—'
      ? { tonality: null, name: null, confidence: 0 }
      : detectTonality(chroma, mode.rootIndex);
    const beat = estimateBPM(data, sr);
    const q = qualityMetrics(data, sr);
    const duration = buffer.duration;
    const structure = detectStructure(data, sr, duration, beat.bpm);
    const melody = melodyGenome(data, sr, chroma);

    // 拍号：按起音包络的「小节级」周期性，在 2/4、3/4、4/4、6/8 里选
    const meterEst = estimateMeter(beat.envelope, beat.envFps, beat.bpm);

    return {
      meta: {
        duration: Math.round(duration * 10) / 10,
        sampleRate: sr,
        channels: buffer.numberOfChannels,
      },
      identity: {
        bpm: beat.bpm,
        bpmConfidence: Math.round(beat.confidence * 100) / 100,
        key: mode.root,
        mode: mode.mode.id,
        modeGlyph: mode.mode.glyph,
        modeName: mode.mode.name,
        modeConfidence: Math.round(mode.confidence * 100) / 100,
        pentaFit: Math.round(mode.pentaFit * 100) / 100,
        // 西方调性：大调 / 小调（与五声标注并列，不互相替代）
        tonality: tonality.tonality,
        tonalityName: tonality.name,
        tonalityConfidence: Math.round((tonality.confidence || 0) * 100) / 100,
        // 例：A 小调 —— 用户从主音名一眼读出西方调号
        westernKey: mode.root === '—' ? null : `${mode.root} ${tonality.name || ''}`.trim(),
        meter: meterEst.meter,
        meterConfidence: meterEst.confidence,
        // 五声坐标：宫音位置 + 主音在五声中的级数。调式互转（同旋律换调式试听）
        // 全靠这两个下标——没有它们就得从模式名反推，兜底分支会反推错。
        gongIndex: mode.gongIndex != null ? mode.gongIndex : null,
        degIndex: mode.degIndex != null ? mode.degIndex : null,
        gongKey: mode.gongRoot || null,
      },
      structure,
      timbre: {
        centroid: Math.round(q.centroid),
        rolloff: Math.round(q.rolloff),
        flatness: Math.round(q.flatness * 100) / 100,
      },
      quality: {
        thd: Math.round(q.thd * 1000) / 1000,
        thdCoverage: q.thdCoverage,
        lra: Math.round(q.lra * 10) / 10,
        rms: q.rms,
        peak: q.peak,
        crest: Math.round(q.crest * 10) / 10,
        lowRatio: Math.round(q.lowRatio * 1000) / 1000,
        subRatio: Math.round(q.subRatio * 1000) / 1000,
        // 低频缺陷分 = max(谐波间涂抹, 工频哼声)。分量必须一起透传：
        // app 的处方要按成因分开诊断（哼声下陷波、涂抹压中低频），
        // 只给综合分会把两件事压成一个数，退回「浑浊度 X%」的旧病。
        mudScore: Math.round(q.mudScore * 100) / 100,
        mudSmear: q.mudSmear != null ? q.mudSmear : Math.round(q.mudScore * 1000) / 1000,
        humScore: q.humScore != null ? q.humScore : 0,
        humFreq: q.humFreq || 0,
        humKind: q.humKind || 'none',
        humProminence: q.humProminence != null ? q.humProminence : 0,
        spectrum: q.spectrum,
      },
      melody,
      /* 证据链：每个 L1 数字背后的原始数据（候选分数、门位、色度……）。
         页面「证据」面板拿它画原图；老存盘没有这一块，app 层会从 raw 重建。 */
      evidence: {
        bpm: beat.evidence || null,
        meter: {
          meter: meterEst.meter,
          confidence: meterEst.confidence,
          scores: meterEst.scores || [],
          reason: meterEst.reason || null,
          info: meterEst.info || null,
        },
        mode: {
          gongRoot: mode.gongRoot || null,
          root: mode.root,
          confidence: mode.confidence,
          pentaFit: mode.pentaFit,
          nEff: mode.nEff != null ? mode.nEff : null,
          relMargin: mode.relMargin != null ? mode.relMargin : null,
          setCert: mode.setCert != null ? mode.setCert : null,
          degScores: mode.degScores || [],
          ranked: mode.ranked || [],
        },
        tonality: tonality.tonality ? tonality : null,
      },
      raw: { chroma, envelope: beat.envelope, envFps: beat.envFps, meterScores: meterEst.scores },
    };
  }

  /* ============================================================
     9. L2 处理链（真实 DSP，离线渲染）
     ============================================================ */

  /**
   * 动态还原（向上扩展），就地改写 buffer。
   *
   * 为什么不能用现成的节点：Web Audio 只有 DynamicsCompressor，而它的
   * ratio 下限是 1 —— 只能往下压，做不了往上的扩展。AI 生成的曲子普遍
   * 被 loudness 目标压扁（LRA 小、瞬态被抹平），要往回张就只能自己算。
   *
   * 做法：先取 10ms 时间常数的能量包络 env，以它的**中位数**为参考 ref，
   * 再按 g = (env/ref)^(k-1) 施加增益 —— k>1 时包络高的地方增益大，
   * 响的更响、轻的更轻，crest factor 就回来了。
   * 两个必须守住的点：
   *   · 参考取中位数而不是均值：个别瞬态不会把 ref 拉走，
   *     增益才在 1 上下摆，不会整段被抬高或压低。
   *   · 增益本身要再平滑一次（涨快落慢）：逐样本跳变的增益
   *     等于直接对波形做调制，那是失真不是动态处理。
   * 范围锁在 ±5 dB，再交回给后面的峰值归一兜底。
   *
   * @param {AudioBuffer} buffer 会被就地修改
   * @param {number} k  扩展比，1 = 不动
   */
  function upExpand(buffer, k) {
    if (!(k > 1.02)) return;
    const sr = buffer.sampleRate;
    const n = buffer.length;
    const nCh = buffer.numberOfChannels;
    if (n < sr * 0.5) return; // 太短估不出可靠的中位数，别动
    const chans = [];
    for (let c = 0; c < nCh; c++) chans.push(buffer.getChannelData(c));

    // 1) 能量包络：单极点平滑，10ms 时间常数
    const aEnv = Math.exp(-1 / (0.010 * sr));
    const env = new Float32Array(n);
    let e = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < nCh; c++) { const v = chans[c][i]; s += v * v; }
      e = s + aEnv * (e - s);
      env[i] = Math.sqrt(e);
    }

    // 2) 参考电平 = 包络中位数（抽样后排序）
    const stride = Math.max(1, (n / 80000) | 0);
    const samp = [];
    for (let i = 0; i < n; i += stride) { const v = env[i]; if (v > 1e-6) samp.push(v); }
    if (samp.length < 128) return;
    samp.sort((a, b) => a - b);
    const ref = samp[samp.length >> 1];
    if (!(ref > 1e-9)) return;

    // 3) 施加增益，限制在 ±5 dB，左右共用同一个增益值
    const gMax = Math.pow(10, 5 / 20);
    const gMin = Math.pow(10, -5 / 20);
    const aAtk = Math.exp(-1 / (0.006 * sr));
    const aRel = Math.exp(-1 / (0.180 * sr));
    let g = 1;
    for (let i = 0; i < n; i++) {
      let r = env[i] / ref;
      if (r > 4) r = 4; else if (r < 0.25) r = 0.25;
      let target = Math.pow(r, k - 1);
      if (target > gMax) target = gMax; else if (target < gMin) target = gMin;
      const a = target > g ? aAtk : aRel;
      g = target + a * (g - target);
      for (let c = 0; c < nCh; c++) chans[c][i] *= g;
    }
  }

  /* BiquadFilter.Q 的引擎读法探测（页面内只跑一次）。
     实测 Chromium：Q.value = p → 截止点增益恰为 p dB（内部线性 Q =
     10^(p/20)）；按规范的线性读法 Q.value = p → 20log10(p) dB。
     取 p=6 拉开差距：dB 读法 +6dB、线性读法 +15.56dB，阈值 10dB 不会误判。
     返回「写进 Q.value 恰等于线性 1/√2」的值——dB 引擎给 −3.0103，
     线性引擎给 0.7071。LR4 分频两节都必须是线性 1/√2，求和才是全通。
     （getFrequencyResponse 与真实渲染逐点一致，同引擎对拍 0dB。） */
  let butterQCache = null;
  function butterQ(ctx) {
    if (butterQCache === null) {
      const probe = ctx.createBiquadFilter();
      probe.type = 'lowpass';
      probe.frequency.value = 1000;
      probe.Q.value = 6;
      const mag = new Float32Array(1);
      probe.getFrequencyResponse(new Float32Array([1000]), mag, new Float32Array(1));
      const db = 20 * Math.log10(Math.max(1e-9, mag[0]));
      // db≈6（+6dB）→ dB 读法 → 要写 −3.0103；db≈15.56 → 线性读法 → 直接写 0.7071
      butterQCache = db > 10 ? 0.7071 : -3.0103;
    }
    return butterQCache;
  }

  async function process(buffer, params) {
    const {
      highpass = 30,
      eq = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      exciter = 0.25,
      denoise = 0.2,
      threshold = 0.35,
      ratio = 0.3,
      intensity = 0.55,
      /* 分治开关。两条链解决的是两组不同的毛病，不是同一条链换个参数：
         · 'ai'       生成音乐 —— 被 loudness 压扁、没有底噪、可能带 aliasing
         · 'acoustic' 真实录音 —— 底噪与工频、房间共鸣、现场动态大
         默认 'ai'：这个产品的对象就是 AI 生成的音乐。 */
      kind = 'ai',
      /* L1 检出的窄带峰（工频哼声/整流纹波）。由检测驱动，两条链都挂——
         哼声是测出来的，不是按素材类别猜的：AI 素材一样能带 50/60Hz。 */
      notches = [],
      /* 动态还原给多少量，0..1。由调用方按实测 LRA 算（见 app.js expandOf）：
         压得越平张得越开，动态本来就够就不动。只在 AI 链上生效。 */
      expand = 0,
    } = params || {};
    const acoustic = kind === 'acoustic';
    /* 强度归一后贯穿全链。旧版各段各有一套互不相干的系数，55% 默认
       强度下实测等响分带差只有 ±2dB、谐波激励混入量仅 6.9%——而
       盲听是等响对齐的，响度优势会被抹掉，剩下的差异听不出来。
       现在的口径：EQ 斜率调到默认强度（55%）正好给满处方；
       激励混入走二次曲线、扩展与压缩随强度线性加码。 */
    const i01 = clamp(intensity, 0, 1);

    const sr = buffer.sampleRate;
    const len = buffer.length;
    // 声道数跟原素材走：立体声进、立体声出。
    // 旧的写死单声道 OfflineAudioContext 会把立体声静默混成单声道，
    // 用户导入立体声、精修后变单声道，属于产品行为与预期不符。
    const nCh = Math.max(1, Math.min(2, buffer.numberOfChannels || 1));
    const ctx = new OfflineAudioContext(nCh, len, sr);

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    // 1) 前置滤波：高通 + 低频隆隆声切除
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = highpass;
    hp.Q.value = 0.71;
    src.connect(hp);

    // 1b) 窄带陷波：L1 检出才挂，挂在 EQ 之前——
    // EQ 里 62Hz 那段是宽 Q 的搁架/钟形，跟 51Hz 的哼声不是一回事，
    // 想下陷必须用专门的 notch，Q 到 34 才砍得动窄带峰。
    let node = hp;
    for (const f of notches) {
      if (!(f > 20)) continue;
      const n = ctx.createBiquadFilter();
      n.type = 'notch';
      n.frequency.value = clamp(f, 20, Math.max(100, sr / 2 - 200));
      n.Q.value = acoustic ? 34 : 24;
      node.connect(n);
      node = n;
    }

    // 2) 动态均衡：10 段 peaking
    const bandFreqs = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    const eqNodes = [];
    bandFreqs.forEach((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking';
      b.frequency.value = f;
      b.Q.value = 1.0;
      // -12..+12 dB，由 -1..1 参数映射。斜率 1/0.55：默认强度（55%）
      // 就给满处方；封顶 1.0 保证实际增益永不超过界面标称的 g×12，
      // 再往上的强度改去推动饱和与动态
      b.gain.value = clamp(eq[i] || 0, -1, 1) * 12 * Math.min(1, i01 / 0.55);
      node.connect(b);
      node = b;
      eqNodes.push(b);
    });

    /* 3) 压缩 —— 只给真实录音。
       现场动态大，压到统一电平是必要的；AI 生成的曲子本来就被 loudness
       目标压扁了，再挂一次压缩器只会把残余的起伏也抹平，而那正是要修的东西。
       录音链走压缩，AI 链走渲染后的向上扩展（upExpand），方向相反。 */
    let head = node;
    if (acoustic) {
      const comp = ctx.createDynamicsCompressor();
      // 强度同样管压缩：旧版 threshold/ratio 两个参数是死的，录音链
      // 无论滑到哪都一样压。dyn 0.85..1.5 缩放两个参数——默认强度
      // （55%）dyn≈1.21 门限 -11.2dB/比值 2.2，已比旧版（-12.4/2.0）
      // 压得深；拉满 -9.6/2.4，归零 -13.2/1.8 只比旧版温和一点。
      const dyn = 0.85 + 0.65 * i01;
      comp.threshold.value = lerp(-18, -2, clamp(threshold * dyn, 0, 1));
      comp.knee.value = 16;
      comp.ratio.value = lerp(1, 4, clamp(ratio * dyn, 0, 1));
      comp.attack.value = 0.014;
      comp.release.value = 0.32;
      node.connect(comp);
      head = comp;
    }

    // 4) 谐波激励：并联 waveshaper（软饱和）
    //
    // 曲线必须**原点斜率 = 1**：小信号不改响度，只有进入膝区才产生谐波。
    // 旧曲线 ((1+k)·x)/(1+k·|x|) 在 x→0 的斜率是 (1+k)——那不是软饱和，
    // 是「驱动增益 + 软削波」，等价于向上压缩：小信号被整体抬高 (1+k) 倍，
    // 底噪跟着抬起来、LRA 被压平（k=2+26·exciter，exciter=0.25 时增益约 9.5 倍）。
    // 现在用 tanh(d·x)/d：斜率恰为 1，大信号渐近 ±1/d，只在膝区加奇次谐波。
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(2048);
    const d = 1 + exciter * (4 + 4 * i01);
    for (let i = 0; i < 2048; i++) {
      const x = (i / 1024) - 1;
      curve[i] = Math.tanh(d * x) / d;
    }
    shaper.curve = curve;
    shaper.oversample = '2x';

    // 并联混合不做增益补偿：wet.gain 只表示「混入多少」。
    // 若给 tanh/d 补 d 倍，小信号又会被抬高，等于把噪声地板的毛病改回来。
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const mix = Math.min(0.55, exciter * i01 * (0.8 + i01));
    dry.gain.value = 1 - mix;
    wet.gain.value = mix;

    /* 分频：低频直通，激励只挂 200Hz 以上。
       tanh 认幅度不认频率——素材最响的往往是低音，全频并联饱和在
       强度拉满时把 150Hz 基频实测削掉 13dB，还经互调把 6k 一起拖低；
       低音绕开波形整形后这两个毛病同时消失。分频用 LR4（两阶级联）：
       单个 2 阶 Butterworth LP+HP 并联在分频点恒为 0（(s²+wc²)/(s²+
       √2·wc·s+wc²) 在 s=j·wc 为零），会挖洞；LR4 求和是全通，幅频才平。
       Q 值必须走 butterQ()：两节都要恰好是线性 1/√2，求和才是全通；
       写死 0.7071 在按 dB 读 Q 的引擎上等于线性 1.085，和会比全通
       在 200Hz 鼓出 +7.4dB（实测），凭空给中频加一座山。 */
    const XO = 200;
    const qXo = butterQ(ctx);
    const band = (type) => {
      const a = ctx.createBiquadFilter();
      a.type = type; a.frequency.value = XO; a.Q.value = qXo;
      const b = ctx.createBiquadFilter();
      b.type = type; b.frequency.value = XO; b.Q.value = qXo;
      head.connect(a); a.connect(b);
      return b;
    };
    const xoLo = band('lowpass');
    const xoHi = band('highpass');
    xoHi.connect(dry);
    xoHi.connect(shaper);
    shaper.connect(wet);

    // 5) 软限幅 / 输出
    const out = ctx.createGain();
    out.gain.value = 0.92;
    xoLo.connect(out);
    dry.connect(out);
    wet.connect(out);

    // 轻度降噪：高通已去底噪，再压极低电平
    //
    // 传输曲线必须**连续**。旧代码在 a=floor 处从 0.35·x 跳到 x，
    // 幅度差 0.65 —— 安静段过零就产生阶跃咔哒。
    // 门限由 denoise 映射到一条区间上（旧的 denoise·0.028 在
    // denoise=0.25 时是 -43dBFS，几乎什么都压不到），过渡用 smoothstep。
    /* 分治的第二处分叉：门开多深。
       录音的底噪是连续的，要真门；AI 素材的噪声地板是合成的、均匀的，
       门下重了啃的不是噪声，是淡出和余韵——所以只做极轻的收口。 */
    const gate = ctx.createWaveShaper();
    const gcurve = new Float32Array(2048);
    const floorDb = acoustic
      ? -80 + clamp(denoise, 0, 1) * 50      // -80 .. -30 dBFS
      : -88 + clamp(denoise, 0, 1) * 33;     // -88 .. -55 dBFS，收得很轻
    const floorAmp = Math.pow(10, floorDb / 20);
    const depth = (acoustic ? 0.72 : 0.28) * clamp(denoise, 0, 1);
    for (let i = 0; i < 2048; i++) {
      const x = (i / 1024) - 1;
      const a = Math.abs(x);
      const t = Math.min(1, a / Math.max(floorAmp, 1e-9));  // 0..1
      const w = t * t * (3 - 2 * t);                        // smoothstep，C¹ 连续
      gcurve[i] = x * ((1 - depth) + depth * w);
    }
    gate.curve = gcurve;
    out.connect(gate);
    gate.connect(ctx.destination);

    src.start(0);
    const rendered = await ctx.startRendering();

    // AI 链的动态还原放在渲染之后：向上扩展要读整段包络找参考电平，
    // Web Audio 没有节点能给这个，只能在样本上自己算。
    // 上限由实测定（expand），用多少由强度定（intensity）——
    // 动态本来就没被压的曲子，把强度拉满也不该去张它。
    if (!acoustic && expand > 0.02) {
      upExpand(rendered, 1 + clamp(expand, 0, 1) * i01 * (1.2 + 0.6 * i01));
    }

    // 峰值归一到 -0.3 dBFS：**双向**，升也降。
    // 旧代码 `if (g < 1)` 只衰减不提升，安静素材精修完还是安静，
    // 与「峰值归一到 -0.3 dBFS」的文案不符（归一 = 对齐到目标峰值，不是限幅）。
    let p = 0;
    for (let c = 0; c < rendered.numberOfChannels; c++) {
      const ch = rendered.getChannelData(c);
      for (let i = 0; i < ch.length; i++) p = Math.max(p, Math.abs(ch[i]));
    }
    if (p > 1e-9) {
      const g = 0.966 / p; // -0.3 dBFS
      for (let c = 0; c < rendered.numberOfChannels; c++) {
        const ch = rendered.getChannelData(c);
        for (let i = 0; i < ch.length; i++) ch[i] *= g;
      }
    }
    return rendered;
  }

  /* ============================================================
     10. L3 旋律基因编辑 + 5 轨合成
     ============================================================ */
  const PENTA_PC = [0, 2, 4, 7, 9]; // 宫调式相对音级

  /** 把音级序列旋转换调（宫↔羽 等） */
  function rotateMode(contour, steps) {
    return contour.map((pc) => {
      const rel = ((pc % 12) + 12) % 12;
      // JS 的 % 对负数返回负值：(rel + steps) % 12 在 steps<0 时会给出负音级，
      // 下游音高换算就错一个八度以上。正模保证恒在 0..11。
      return (((rel + steps) % 12) + 12) % 12;
    });
  }

  /** 按调式生成 5 轨短句 */
  async function renderArrangement(opts) {
    const {
      rootMidi = 60,
      modeIndex = 0,
      bpm = 92,
      bars = 4,
      sr = 44100,
      muted = {},
      seed = 7,
      meter = '4/4',
    } = opts || {};

    /* 拍号 → 每小节拍数 + 强弱轮廓。分析出什么就写什么：
       分析出 5/4 却按 4/4 再生，产品会自相矛盾（旧版 beatsPerBar 写死 4）。 */
    const METER_ACCENTS = {
      '2/4': { beats: 2, accents: [1.0, 0.52] },
      '3/4': { beats: 3, accents: [1.0, 0.50, 0.50] },
      '4/4': { beats: 4, accents: [1.0, 0.55, 0.76, 0.55] },
      '5/4': { beats: 5, accents: [1.0, 0.50, 0.50, 0.78, 0.50] },
      '6/8': { beats: 6, accents: [1.0, 0.46, 0.46, 0.80, 0.46, 0.46] },
      '7/8': { beats: 7, accents: [1.0, 0.50, 0.50, 0.80, 0.50, 0.50, 0.50] },
    };
    const mp = METER_ACCENTS[meter] || METER_ACCENTS['4/4'];
    const meterUsed = METER_ACCENTS[meter] ? meter : '4/4';
    const beatsPerBar = mp.beats;
    const accents = mp.accents;
    const totalBeats = bars * beatsPerBar;
    const durSec = (totalBeats * 60) / bpm;
    const totalSamples = Math.ceil(durSec * sr) + Math.floor(sr * 0.6);
    const ctx = new OfflineAudioContext(2, totalSamples, sr);

    const degrees = MODES[modeIndex % MODES.length].degrees;
    const scale = degrees.map((d) => rootMidi + d);

    // 确定性伪随机
    let s = seed;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };

    const master = ctx.createGain();
    master.gain.value = 0.82;
    master.connect(ctx.destination);

    const tracks = [
      { id: 'lead',  name: '主旋', gain: 0.34, color: '#C66B3D' },
      { id: 'harm',  name: '和声', gain: 0.19, color: '#B08B6E' },
      { id: 'bass',  name: '贝斯', gain: 0.26, color: '#606C38' },
      { id: 'drums', name: '鼓组', gain: 0.22, color: '#C08E3A' },
      { id: 'pad',   name: '氛围', gain: 0.15, color: '#8B9D83' },
    ];

    const events = []; // 用于前端可视化

    /* 事件要带力度，导出 MIDI 才有强弱。底值按各轨在混音里的配比排
       （主旋最响、氛围最轻），再乘小节的强弱轮廓——这样 MIDI 里的
       力度分布和离线渲染听到的一致，而不是导出来全是 100。 */
    const VEL = { lead: 112, harm: 84, bass: 100, drums: 96, pad: 66 };
    const velAt = (id, pos) =>
      clamp(Math.round(VEL[id] * (0.55 + 0.45 * (accents[pos] || 0.5))), 1, 127);

    function voice(type, freq, t, dur, gain) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = type === 'bass' ? 480 : type === 'pad' ? 1500 : 3200;
      o.type = type === 'bass' ? 'triangle' : type === 'pad' ? 'sine' : 'triangle';
      o.frequency.value = freq;
      const peak = gain;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(f); f.connect(g); g.connect(master);
      o.start(t); o.stop(t + dur + 0.05);
    }

    function noiseHit(t, dur, gain, hpFreq) {
      const len = Math.floor(sr * dur);
      const buf = ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (rnd() * 2 - 1) * Math.pow(1 - i / len, 2.2);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = hpFreq;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t);
    }

    const beatSec = 60 / bpm;
    const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

    // 主旋：五声音阶乐句。乐句落在主音上，起讫都回到 degree 0，
    // 否则调式互转选了「宫」，成品却读成「徵」——中心就白选了。
    const phrase = [0, 1, 2, 3, 4, 3, 2, 1, 0, 2, 4, 3, 1, 0, 2, 0];
    for (let b = 0; b < totalBeats; b++) {
      const t = b * beatSec;
      const degIdx = phrase[b % phrase.length];
      // 乐句每两小节呼吸一次：末拍抬八度、拉长——按小节算，不是按 8 拍硬数
      const lastOfPhrase = b % (beatsPerBar * 2) === beatsPerBar * 2 - 1;
      const lastOfBar = b % beatsPerBar === beatsPerBar - 1;
      const midi = scale[degIdx % scale.length] + (lastOfPhrase ? 12 : 0);
      const dur = beatSec * (lastOfBar ? 1.4 : 0.72);
      if (!muted.lead) {
        voice('lead', midiToHz(midi), t, dur, 0.34);
        events.push({ track: 'lead', t, dur, note: midi, deg: degIdx, vel: velAt('lead', b % beatsPerBar) });
      }
    }

    // 和声：主音占多数小节，其余小节离开再回来，让主音持续是调性中心
    const prog = [0, 0, 2, 0, 0, 1, 3, 0];
    for (let bar = 0; bar < bars; bar++) {
      const t = bar * beatsPerBar * beatSec;
      const rootDeg = prog[bar % prog.length];
      if (muted.harm) continue;
      // 和弦换音的小节抬一点，同和弦延续的小节收一点
      const harmChange = bar === 0 ||
        rootDeg !== prog[(bar + prog.length - 1) % prog.length];
      [0, 2, 4].forEach((d, i) => {
        const midi = scale[(rootDeg + i) % scale.length] - 12;
        const t0 = t + i * 0.012;
        // 三音不再同力度：根音承重、三五音递减，再叠换和弦的呼吸。
        // 渲染增益按 vel/底值 同比缩放 —— MIDI 里看到的强弱就是混音里听到的。
        const vel = clamp(Math.round(
          VEL.harm * (i === 0 ? 1 : i === 1 ? 0.88 : 0.80) * (harmChange ? 1 : 0.92)
        ), 1, 127);
        voice('harm', midiToHz(midi), t0, beatSec * 1.85, 0.19 * (vel / VEL.harm));
        events.push({ track: 'harm', t: t0, dur: beatSec * 1.85, note: midi, deg: rootDeg + i, vel });
      });
    }

    // 贝斯：根音 + 小节中段的附点支撑，跟和声同一个进行。
    // 支撑点落在 floor(beats/2)：4/4 是第 3 拍，3/4 是第 2 拍，7/8 是第 4 拍。
    const midBeat = Math.floor(beatsPerBar / 2);
    for (let bar = 0; bar < bars; bar++) {
      const t = bar * beatsPerBar * beatSec;
      const rootDeg = prog[bar % prog.length];
      const midi = scale[rootDeg % scale.length] - 24;
      if (muted.bass) continue;
      voice('bass', midiToHz(midi), t, beatSec * 1.55, 0.26);
      voice('bass', midiToHz(midi), t + beatSec * midBeat, beatSec * 0.9, 0.17);
      events.push({ track: 'bass', t, dur: beatSec * 1.55, note: midi, deg: rootDeg, vel: velAt('bass', 0) });
      events.push({ track: 'bass', t: t + beatSec * midBeat, dur: beatSec * 0.9, note: midi, deg: rootDeg, vel: velAt('bass', midBeat) });
    }

    // 鼓组：按拍号强弱轮廓打点，不是按「每 4 拍」硬循环。
    // 5/4 的重音在 1/4，7/8 在 1/4，硬写 b%4 会把奇数拍的小节打乱。
    for (let b = 0; b < totalBeats; b++) {
      const t = b * beatSec;
      if (muted.drums) continue;
      const pos = b % beatsPerBar;
      const acc = accents[pos] || 0.5;
      // 力度直接取这次打击的增益配比，不再乘一遍强弱轮廓——
      // 强弱已经写在 0.30/0.20/0.16 这三个数里了，再乘一次会叠两遍
      if (acc >= 0.75) {
        noiseHit(t, 0.16, 0.30, 1100);            // 强拍木鱼类
        events.push({ track: 'drums', t, dur: 0.16, note: 36, deg: 0, vel: 116 });
      } else if (acc >= 0.45 && pos % 2 === 0) {
        noiseHit(t, 0.16, 0.20, 1100);            // 弱拍轻打
        events.push({ track: 'drums', t, dur: 0.16, note: 36, deg: 0, vel: 82 });
      }
      if (pos === midBeat) {
        noiseHit(t, 0.09, 0.16, 3200);            // 军鼓位置
        events.push({ track: 'drums', t, dur: 0.09, note: 38, deg: 0, vel: 68 });
      }
    }

    // 氛围：每小节一次长音，跟进行同根音高八度，压住主音
    for (let bar = 0; bar < bars; bar++) {
      const t = bar * beatsPerBar * beatSec;
      const rootDeg = prog[bar % prog.length];
      const midi = scale[rootDeg % scale.length] + 12;
      if (muted.pad) continue;
      // 换和弦的小节起得响，延续的小节垫得轻 —— 力度变化同时写进
      // MIDI 和渲染增益（vel/底值 同比），两条输出听到的是同一件事
      const padChange = bar === 0 ||
        rootDeg !== prog[(bar + prog.length - 1) % prog.length];
      const vel = clamp(Math.round(VEL.pad * (padChange ? 1 : 0.85)), 1, 127);
      voice('pad', midiToHz(midi), t, beatSec * (beatsPerBar * 0.9), 0.15 * (vel / VEL.pad));
      events.push({ track: 'pad', t, dur: beatSec * (beatsPerBar * 0.9), note: midi, deg: rootDeg, vel });
    }

    const rendered = await ctx.startRendering();
    // 拍号是我们自己写进去的，不是估出来的——回传真值，别让盲分析去猜
    return { buffer: rendered, events, tracks, duration: durSec, scale, meter: meterUsed, beatsPerBar };
  }

  /* ============================================================
     11. 导出：WAV / MIDI
     ============================================================ */
  function bufferToWav(buffer, bitDepth = 16) {
    const numCh = Math.min(buffer.numberOfChannels, 2);
    const len = buffer.length;
    const sr = buffer.sampleRate;
    const bytesPer = bitDepth / 8;
    const blockAlign = numCh * bytesPer;
    const dataSize = len * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const dv = new DataView(ab);

    const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF');
    dv.setUint32(4, 36 + dataSize, true);
    wstr(8, 'WAVE');
    wstr(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, numCh, true);
    dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * blockAlign, true);
    dv.setUint16(32, blockAlign, true);
    dv.setUint16(34, bitDepth, true);
    wstr(36, 'data');
    dv.setUint32(40, dataSize, true);

    // 位深分支必须和 bytesPer 对齐：头里 blockAlign/dataSize 按 bitDepth/8 算，
    // 样本写入却少写字节的话，声明的 data 区会比实际写入的长，出来是坏文件。
    // 16 与 8 各写各的字节数；24 按三字节小端写，不借用 8 位那条 else。
    const chans = [];
    for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
    let off = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        const v = clamp(chans[c][i], -1, 1);
        if (bitDepth === 16) {
          dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
          off += 2;
        } else if (bitDepth === 24) {
          // 对称量化：±1 → ∓/±8388607（0x7FFFFF）。
          // 不用满负端 -8388608，正负幅度一致，直流偏置为 0。
          let s = Math.round(v * 8388607);
          if (s > 8388607) s = 8388607;
          if (s < -8388607) s = -8388607;
          const u = s < 0 ? s + 0x1000000 : s; // 负数按 24 位补码
          dv.setUint8(off, u & 0xff);
          dv.setUint8(off + 1, (u >> 8) & 0xff);
          dv.setUint8(off + 2, (u >> 16) & 0xff);
          off += 3;
        } else {
          dv.setUint8(off, Math.round((v * 0.5 + 0.5) * 255));
          off += 1;
        }
      }
    }
    if (off !== 44 + dataSize) {
      // 字节数对不上就是头和数据打架，宁可报错也别吐一个能被打开的坏文件
      throw new Error(`bufferToWav: 写入 ${off - 44} 字节，头声明 ${dataSize} 字节`);
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  /** 生成标准 MIDI 文件（单轨五声旋律） */
  /* 乐器编排：General MIDI 音色号（0-based）与通道。
     鼓组必须走通道 9，那是 GM 规范里唯一的打击通道——
     塞到 0 号通道上，DAW 会拿钢琴音色去打鼓。
     通道避开 9，其余按轨顺排。 */
  const MIDI_PROG = {
    lead:  { ch: 0, prog: 73, name: '主旋' }, // Flute
    harm:  { ch: 1, prog: 52, name: '和声' }, // Choir Aahs
    bass:  { ch: 2, prog: 32, name: '贝斯' }, // Acoustic Bass
    drums: { ch: 9, prog: null, name: '鼓组' }, // 打击通道，不发 program change
    pad:   { ch: 3, prog: 89, name: '氛围' }, // Pad 2 (warm)
  };
  const MIDI_TRACK_ORDER = ['lead', 'harm', 'bass', 'drums', 'pad'];

  const utf8 = (s) => Array.from(new TextEncoder().encode(String(s)));

  /* SMF Format 1：一个 conductor 轨放速度/拍号，每种乐器一个独立轨。
     旧版写的是 Format 0 的单轨单通道，五种乐器全挤在一起、
     没有轨名也没有音色号——导进 DAW 只能整段重写，等于没导出。
     分轨是「导出 MIDI」这个按钮的全部意义，所以这里必须一轨一乐器。 */
  function eventsToMidi(events, opts) {
    const o = typeof opts === 'number' ? { bpm: opts } : (opts || {});
    const bpm = o.bpm || 92;
    const TICKS = 480;
    const meter = o.meter || '4/4';
    const title = o.title || '音智新媒 · 再生乐段';
    const note = o.note || '';

    const vlq = (v) => {
      const b = [v & 0x7f];
      while ((v >>= 7)) b.unshift((v & 0x7f) | 0x80);
      return b;
    };
    // meta 事件 = delta + FF + type + VLQ 长度 + 数据
    const meta = (type, data) => [...vlq(0), 0xff, type, ...vlq(data.length), ...data];

    /* 拍号的分母在文件里存的是 2 的幂：4/4 写 2，6/8 写 3。
       照抄字符串会被读成「分母 4」的 6/4 拍，小节线全错位。 */
    const [mm, dd] = String(meter).split('/');
    const num = clamp(parseInt(mm, 10) || 4, 1, 32);
    const den = clamp(parseInt(dd, 10) || 4, 1, 64);
    const denPow = Math.max(0, Math.round(Math.log2(den)));

    const tempo = Math.round(60000000 / bpm);
    const head = [
      ...meta(0x03, utf8(title)),
      ...(note ? meta(0x01, utf8(note)) : []),
      ...vlq(0), 0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff,
      ...vlq(0), 0xff, 0x58, 0x04, num, denPow, 24, 8,
      ...meta(0x2f, []),
    ];

    /* 按轨分组。muted 的轨在 renderArrangement 里根本不会 push 事件，
       所以这里拿到多少轨就导多少轨，不会给 DAW 留空轨。 */
    const groups = new Map();
    for (const e of events || []) {
      const k = e.track || '_';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    const order = MIDI_TRACK_ORDER.filter((k) => groups.has(k));
    for (const k of groups.keys()) if (!order.includes(k)) order.push(k);

    const chunks = [];
    let ntrk = 0;
    const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    const pushTrack = (bytes) => {
      chunks.push(new Uint8Array([0x4d, 0x54, 0x72, 0x6b, ...u32(bytes.length)]));
      chunks.push(new Uint8Array(bytes));
      ntrk++;
    };

    pushTrack(head);

    for (const key of order) {
      const evs = groups.get(key);
      const def = MIDI_PROG[key] || { ch: 0, prog: 0, name: key };
      const ch = def.ch & 0x0f;
      const bytes = [...meta(0x03, utf8(def.name))];
      if (def.prog != null) bytes.push(...vlq(0), 0xc0 | ch, def.prog);

      const marks = [];
      for (const e of evs) {
        const on = Math.round((e.t * bpm / 60) * TICKS);
        // 至少留 1 tick：同 tick 的 note-off 会按「先关后开」排序，
        // 零时值音符会被自己的 off 立刻掐掉，在 DAW 里等于没这个音
        const off = Math.max(on + 1, Math.round(((e.t + (e.dur || 0)) * bpm / 60) * TICKS));
        const n = clamp(Math.round(e.note), 0, 127);
        const v = clamp(Math.round(e.vel != null ? e.vel : 100), 1, 127);
        marks.push({ t: on, k: 1, n, v });
        marks.push({ t: off, k: 0, n, v: 64 });
      }
      // 同 tick 先 note-off 再 note-on：同音高的连击才不会被上一个音的尾巴糊住
      marks.sort((a, b) => a.t - b.t || a.k - b.k);

      let last = 0;
      for (const m of marks) {
        bytes.push(...vlq(Math.max(0, m.t - last)));
        last = m.t;
        if (m.k) bytes.push(0x90 | ch, m.n, m.v);
        else bytes.push(0x80 | ch, m.n, m.v);
      }
      bytes.push(...meta(0x2f, []));
      pushTrack(bytes);
    }

    const header = new Uint8Array([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6,
      0, 1,                                   // format 1
      0, ntrk,                                // 轨数（conductor + 乐器轨）
      (TICKS >> 8) & 0xff, TICKS & 0xff,
    ]);
    return new Blob([header, ...chunks], { type: 'audio/midi' });
  }

  /* ============================================================
     打包：把分轨 + MIDI 收进一个 zip
     ------------------------------------------------------------
     原来的分轨导出是连发 5 次下载，浏览器会拦「多次下载」，
     用户拿到的还是 5 个散文件 + 1 个 mid，得自己归堆。
     WAV 本来就是定长样本，压缩几乎没收益，所以用 store 方式
     （method = 0）直接拼字节，不引第三方库。
     ============================================================ */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /**
   * @param {Array<{name:string, data:Uint8Array}>} files
   * @returns {Blob} store 方式（不压缩）的 zip
   */
  function makeZip(files) {
    const enc = new TextEncoder();
    const z16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
    // ZIP 里所有 32 位字段都是小端（长度、CRC、中央目录偏移全是），写反了
    // unzip 会报 missing N bytes。z16 本来就是小端，两个必须同向。
    const z32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
    // 时间戳固定成 1980-01-01：同一份产物每次打包字节完全一致，方便对拍
    const DOS_TIME = 0;
    const DOS_DATE = (1 << 5) | 1;
    const FLAG_UTF8 = 0x0800;

    const parts = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const name = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const local = [
        0x50, 0x4b, 0x03, 0x04,                       // local file header
        ...z16(20), ...z16(FLAG_UTF8), ...z16(0),     // version, flags, method = store
        ...z16(DOS_TIME), ...z16(DOS_DATE),
        ...z32(crc), ...z32(data.length), ...z32(data.length),
        ...z16(name.length), ...z16(0),
      ];
      parts.push(new Uint8Array(local), name, data);
      central.push({ name, crc, size: data.length, offset });
      offset += local.length + name.length + data.length;
    }

    const cdStart = offset;
    const cdParts = [];
    for (const c of central) {
      cdParts.push(new Uint8Array([
        0x50, 0x4b, 0x01, 0x02,                       // central directory header
        ...z16(20), ...z16(20),                       // version made by / needed
        ...z16(FLAG_UTF8), ...z16(0),                 // flags, method
        ...z16(DOS_TIME), ...z16(DOS_DATE),
        ...z32(c.crc), ...z32(c.size), ...z32(c.size),
        ...z16(c.name.length),
        ...z16(0), ...z16(0),                         // extra, comment
        ...z16(0), ...z16(0),                         // disk, internal attrs
        ...z32(0),                                    // external attrs
        ...z32(c.offset),
      ]), c.name);
    }
    const cdSize = cdParts.reduce((n, p) => n + p.length, 0);

    const eocd = new Uint8Array([
      0x50, 0x4b, 0x05, 0x06,                       // end of central directory
      ...z16(0), ...z16(0),
      ...z16(central.length), ...z16(central.length),
      ...z32(cdSize), ...z32(cdStart),
      ...z16(0),
    ]);

    return new Blob([...parts, ...cdParts, eocd], { type: 'application/zip' });
  }

  /* ============================================================
     11.5 原文件采样率嗅探
     decodeAudioData 会把任何素材重采到 AudioContext 的采样率，所以从解码后
     的 buffer 读 sampleRate 拿到的永远是「分析采样率」——48k 的 FLAC 会被
     报成 44.1k，而指标副标写的是「原始采样率」，那就是在撒谎。
     这里直接啃文件头读原生采样率；读不出（ogg/m4a/aac/ape）返回 0，
     由调用方退回分析采样率并把副标改成实话。
     ============================================================ */
  function sniffSampleRate(bytes) {
    try {
      const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
      if (b.length < 24) return 0;
      const tag = (i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);

      // WAV：RIFF....WAVE，顺着 chunk 走找 fmt（有的文件在 fmt 前塞了 LIST）
      if (tag(0) === 'RIFF' && tag(8) === 'WAVE') {
        let p = 12;
        while (p + 8 <= b.length) {
          const id = tag(p), len = view.getUint32(p + 4, true);
          if (id === 'fmt ') return p + 12 <= b.length ? view.getUint32(p + 12, true) : 0;
          p += 8 + len + (len & 1);
        }
        return 0;
      }

      // FLAC：fLaC + STREAMINFO；采样率是 STREAMINFO 里紧接10 字节之后的 20 位
      if (tag(0) === 'fLaC') {
        if (b.length < 26) return 0;
        return (((b[18] << 12) | (b[19] << 4) | (b[20] >> 4)) >>> 0) || 0;
      }

      // AIFF：FORM....AIFF，COMM 块第 8 字节起是 80 位 SANE 扩展浮点
      if (tag(0) === 'FORM' && (tag(8) === 'AIFF' || tag(8) === 'AIFC')) {
        let p = 12;
        while (p + 8 <= b.length) {
          const id = tag(p), len = view.getUint32(p + 4, false);
          if (id === 'COMM' && p + 8 + 10 <= b.length) {
            const e = p + 8 + 8;
            const exp = ((b[e] << 8) | b[e + 1]) & 0x7fff;
            if (!exp) return 0;
            let m = 0;
            for (let k = 0; k < 8; k++) m = m * 256 + b[e + 2 + k];
            return Math.round(m * Math.pow(2, exp - 16383 - 63)) || 0;
          }
          p += 8 + len + (len & 1);
        }
        return 0;
      }

      // MP3：跳 ID3v2 后找帧同步字，采样率由版本 + 索引两张小表决定
      let p = 0;
      if (tag(0) === 'ID3' && b.length > 10) {
        const sz = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) |
                   ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
        p = 10 + sz;
      }
      const MPEG1 = [44100, 48000, 32000], MPEG2 = [22050, 24000, 16000], MPEG25 = [11025, 12000, 8000];
      // 只扫开头 1MB：MP3 帧头必在文件前部，扫全曲既慢也没意义
      for (let i = p; i < Math.min(b.length - 4, p + (1 << 20)); i++) {
        if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
        const ver = (b[i + 1] >> 3) & 3, idx = (b[i + 2] >> 6) & 3;
        if (ver === 1 || idx === 3) continue;
        return (ver === 3 ? MPEG1 : ver === 2 ? MPEG2 : MPEG25)[idx];
      }
      return 0;
    } catch (e) {
      return 0;
    }
  }

  /* ============================================================
     12. 示例音频合成（真实的五声调式作品）
     ============================================================ */
  async function synthesizeDemo() {
    const sr = 44100;
    const bpm = 92;
    const bars = 8;
    const beatSec = 60 / bpm;
    const durSec = bars * 4 * beatSec + 0.5;
    const ctx = new OfflineAudioContext(1, Math.ceil(durSec * sr), sr);

    const master = ctx.createGain();
    master.gain.value = 0.78;
    master.connect(ctx.destination);

    const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
    // C 宫五声
    const scale = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81];

    function tone(freq, t, dur, gain, type = 'triangle', cutoff = 2800) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = cutoff;
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.018);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(f); f.connect(g); g.connect(master);
      o.start(t); o.stop(t + dur + 0.05);
    }

    // 有意注入的问题：35Hz 隆隆声 + 底噪 → 给 L2 一个真实的修复对象
    const rumble = ctx.createOscillator();
    const rg = ctx.createGain();
    rumble.type = 'sine'; rumble.frequency.value = 34;
    rg.gain.value = 0.115;
    rumble.connect(rg); rg.connect(master);
    rumble.start(0); rumble.stop(durSec);

    const noiseBuf = ctx.createBuffer(1, Math.ceil(durSec * sr), sr);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 0.0115;
    const ns = ctx.createBufferSource();
    ns.buffer = noiseBuf;
    const nf = ctx.createBiquadFilter();
    nf.type = 'lowpass'; nf.frequency.value = 5200;
    const ng = ctx.createGain(); ng.gain.value = 1;
    ns.connect(nf); nf.connect(ng); ng.connect(master);
    ns.start(0);

    // 旋律（宫调式乐句）
    const mel = [
      0, 1, 2, 3, 4, 3, 2, 1,
      0, 2, 4, 5, 4, 3, 2, 0,
      3, 4, 5, 4, 3, 2, 1, 0,
      1, 2, 3, 4, 3, 2, 1, 0,
      0, 1, 2, 4, 5, 4, 2, 1,
      0, 2, 3, 4, 5, 4, 3, 2,
      1, 0, 1, 2, 3, 2, 1, 0,
      0, 2, 4, 3, 2, 1, 0, 0,
    ];
    for (let b = 0; b < bars * 4; b++) {
      const t = b * beatSec;
      const idx = mel[b % mel.length];
      const midi = scale[idx % scale.length];
      tone(midiToHz(midi), t, beatSec * (b % 4 === 3 ? 1.25 : 0.68), 0.3, 'triangle', 3000);
    }
    // 贝斯
    for (let bar = 0; bar < bars; bar++) {
      const t = bar * 4 * beatSec;
      const root = bar % 2 === 0 ? 36 : 43;
      tone(midiToHz(root), t, beatSec * 1.7, 0.24, 'triangle', 420);
      tone(midiToHz(root), t + beatSec * 2, beatSec * 1.1, 0.16, 'triangle', 420);
    }
    // 和声垫
    for (let bar = 0; bar < bars; bar++) {
      const t = bar * 4 * beatSec;
      [60, 64, 67].forEach((m, i) => {
        tone(midiToHz(m - 12), t + i * 0.02, beatSec * 3.4, 0.1, 'sine', 1500);
      });
    }
    // 打击
    for (let b = 0; b < bars * 4; b++) {
      const t = b * beatSec;
      const len = Math.floor(sr * 0.13);
      const buf = ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4);
      const s = ctx.createBufferSource(); s.buffer = buf;
      const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1200;
      const g = ctx.createGain(); g.gain.value = b % 2 === 0 ? 0.24 : 0.12;
      s.connect(f); f.connect(g); g.connect(master);
      s.start(t);
    }

    return await ctx.startRendering();
  }

  /* ---------- 导出 ---------- */
  global.SonicEngine = {
    analyze,
    process,
    renderArrangement,
    synthesizeDemo,
    bufferToWav,
    eventsToMidi,
    makeZip,
    sniffSampleRate,
    measureLoudness,
    matchLoudness,
    loudnessCurve,
    transposeMelodyToMode,
    renderMelodyPreview,
    buildScore,
    MODES,
    PC_NAMES,
    PENTA_PC,
    rotateMode,
    fmt,
    clamp,
    dbFrom,
    // 以下为内部算法的测试钩子：基准脚本用它们与地面真值对拍
    _internals: {
      fft, hann, frameSpectrum, chromaFromSpectrum,
      detectMode, detectTonality, estimateBPM, estimateMeter,
      qualityMetrics, detectStructure, melodyGenome,
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
