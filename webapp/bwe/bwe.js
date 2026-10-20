// TCS-BWE 浏览器移植版：与 paper/bwe/bwe（numpy 参考实现）逐函数对拍。
// 铁律：本文件是只读移植，不改动论文代码；数值口径以 tools/reference/*.json 为准。
// 结构：共享 PRNG -> FFT -> STFT(WOLA) -> f0/置信度/乐理门 -> 恢复主循环 -> 指标。

// ------------------------------------------------------------ 共享 PRNG
// 与 tools/make_assets.py 的 Mulberry32BoxMuller 逐位一致（seed=20261018）。
export class Mulberry32BoxMuller {
  constructor(seed) {
    this.a = seed >>> 0;
    this._spare = null;
  }
  _next01() {
    this.a = (this.a + 0x6D2B79F5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniformArr(n) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = this._next01() * (2 * Math.PI);
    return out;
  }
  normal2d(nFrames, nNb) {
    const out = new Float64Array(nFrames * nNb);
    let i = 0;
    const n = out.length;
    while (i < n) {
      if (this._spare !== null) {
        out[i] = this._spare;
        this._spare = null;
        i++;
        continue;
      }
      const u1 = Math.max(this._next01(), 1e-12);
      const u2 = this._next01();
      const r = Math.sqrt(-2 * Math.log(u1));
      const th = 2 * Math.PI * u2;
      out[i] = r * Math.cos(th);
      if (i + 1 < n) {
        out[i + 1] = r * Math.sin(th);
        i += 2;
      } else {
        this._spare = r * Math.sin(th);
        i++;
      }
    }
    return out;
  }
}

// ------------------------------------------------------------ FFT（radix-2 + Bluestein）
function fftPow2(re, im, inverse) {
  const n = re.length;
  // 位反转
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
    const ang = (inverse ? 2 : -2) * Math.PI / len;
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
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

function isPow2(n) { return n > 0 && (n & (n - 1)) === 0; }

// 任意长度 DFT（非 2 的幂走 Bluestein），inverse=false 为正变换 exp(-i2πkn/N)
function dft(reIn, imIn, n, inverse) {
  const re = Float64Array.from(reIn);
  const im = Float64Array.from(imIn);
  if (isPow2(n)) {
    fftPow2(re, im, inverse);
    return { re, im };
  }
  // Bluestein：X[j] = w^{-j²/2} * Σ a[k] b[j-k]，a[k]=x[k] w^{-k²/2}, b=conj chirp
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const sgn = inverse ? 1 : -1;
  const ar = new Float64Array(m), ai = new Float64Array(m);
  const br = new Float64Array(m), bi = new Float64Array(m);
  const chr = new Float64Array(n), chi = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const kk = (k * k) % (2 * n);          // e^{iπk²/N} 周期化防大数精度损失
    const ang = Math.PI * kk / n;
    // chirp c[k] = e^{i·sgn·π k²/N}
    const c = Math.cos(sgn * ang), s = Math.sin(sgn * ang);
    chr[k] = c; chi[k] = s;
    // a[k] = x[k] * c[k]
    ar[k] = reIn[k] * c - imIn[k] * s;
    ai[k] = reIn[k] * s + imIn[k] * c;
    // b[k] = conj(c[k])；负下标 (j-k)²=k² → b[m-k] 直接镜像同一值
    br[k] = c; bi[k] = -s;
    if (k > 0) { br[m - k] = c; bi[m - k] = -s; }
  }
  // 线性卷积：FFT(a)*FFT(b) -> IFFT
  fftPow2(ar, ai, false);
  fftPow2(br, bi, false);
  for (let k = 0; k < m; k++) {
    const rr = ar[k] * br[k] - ai[k] * bi[k];
    const ii = ar[k] * bi[k] + ai[k] * br[k];
    ar[k] = rr; ai[k] = ii;
  }
  fftPow2(ar, ai, true);
  const scale = inverse ? 1 / n : 1;
  for (let j = 0; j < n; j++) {
    // 乘 chirp 得到 X[j]（逆变换补 1/n）
    const rr = ar[j] * chr[j] - ai[j] * chi[j];
    const ii = ar[j] * chi[j] + ai[j] * chr[j];
    re[j] = rr * scale; im[j] = ii * scale;
  }
  return { re, im };
}

// rfft：全长实序列 -> 前 n/2+1（偶）bin，与 numpy 同布局
export function rfftFull(x) {
  const n = x.length;
  const { re, im } = dft(x, new Float64Array(n), n, false);
  const nb = Math.floor(n / 2) + 1;
  return { re: re.subarray(0, nb), im: im.subarray(0, nb), n };
}

export function irfftFull(X, n) {
  const nb = Math.floor(n / 2) + 1;
  const fullRe = new Float64Array(n);
  const fullIm = new Float64Array(n);
  for (let k = 0; k < nb && k < n; k++) { fullRe[k] = X.re[k]; fullIm[k] = X.im[k]; }
  for (let k = 1; k < nb && n - k < n; k++) {
    if (n - k === k) continue;
    if (n - k <= 0 || k >= n) continue;
    fullRe[n - k] = X.re[k];
    fullIm[n - k] = -X.im[k];
  }
  const { re, im } = dft(fullRe, fullIm, n, true);
  return re;
}

export function rfftfreq(n, sr) {
  const nb = Math.floor(n / 2) + 1;
  const f = new Float64Array(nb);
  for (let k = 0; k < nb; k++) f[k] = (k * sr) / n;
  return f;
}

// ------------------------------------------------------------ 窗与 STFT（WOLA）
export function periodicHann(n) {
  const w = new Float64Array(n);
  for (let k = 0; k < n; k++) w[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / n);
  return w;
}

export class STFT {
  constructor(nFft = 2048, hop = 512) {
    this.n_fft = nFft;
    this.hop = hop;
    this.win = periodicHann(nFft);
    this._head = 0;
    this._origLen = 0;
  }
  analysis(x) {
    const nFft = this.n_fft, hop = this.hop, win = this.win;
    this._head = nFft;
    this._origLen = x.length;
    const padded = new Float64Array(x.length + 2 * nFft);
    padded.set(x, nFft);
    const n = padded.length;
    const nFrames = 1 + Math.floor((n - nFft) / hop);
    const nBins = Math.floor(nFft / 2) + 1;
    const re = new Float64Array(nFrames * nBins);
    const im = new Float64Array(nFrames * nBins);
    const fr = new Float64Array(nFft);
    const fi = new Float64Array(nFft);
    for (let t = 0; t < nFrames; t++) {
      const off = t * hop;
      for (let i = 0; i < nFft; i++) { fr[i] = padded[off + i] * win[i]; fi[i] = 0; }
      fftPow2(fr, fi, false);
      re.set(fr.subarray(0, nBins), t * nBins);
      im.set(fi.subarray(0, nBins), t * nBins);
    }
    return { re, im, nFrames, nBins };
  }
  synthesis(S, length) {
    const nFft = this.n_fft, hop = this.hop, win = this.win;
    const nBins = Math.floor(nFft / 2) + 1;
    const nOut = (S.nFrames - 1) * hop + nFft;
    const y = new Float64Array(nOut);
    const wsum = new Float64Array(nOut);
    const fr = new Float64Array(nFft);
    const fi = new Float64Array(nFft);
    for (let t = 0; t < S.nFrames; t++) {
      fr.fill(0); fi.fill(0);
      fr.set(S.re.subarray(t * nBins, t * nBins + nBins), 0);
      fi.set(S.im.subarray(t * nBins, t * nBins + nBins), 0);
      // irfft：共轭补全后逆变换
      for (let k = 1; k + 1 < nBins; k++) {
        fr[nFft - k] = fr[k];
        fi[nFft - k] = -fi[k];
      }
      fi[0] = 0;
      if (nFft % 2 === 0) fi[nFft / 2] = 0;
      fftPow2(fr, fi, true);
      const s = t * hop;
      for (let i = 0; i < nFft; i++) {
        y[s + i] += fr[i] * win[i];
        wsum[s + i] += win[i] * win[i];
      }
    }
    for (let i = 0; i < nOut; i++) if (wsum[i] > 1e-10) y[i] /= wsum[i];
    const head = this._head;
    const len = length !== undefined ? length : this._origLen;
    return y.subarray(head, head + len);
  }
}

// ------------------------------------------------------------ 小工具
export function searchSortedLeft(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function geomspace(lo, hi, num) {
  const out = new Float64Array(num);
  const ratio = Math.pow(hi / lo, 1 / (num - 1));
  out[0] = lo;
  for (let i = 1; i < num; i++) out[i] = out[i - 1] * ratio;
  out[num - 1] = hi;
  return out;
}

// numpy.convolve(x, w, mode='same')（full 裁剪起点 (len(w)-1)>>1）
function convSame(x, w) {
  const n = x.length, m = w.length;
  const half = (m - 1) >> 1;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < m; j++) {
      const xi = i + half - j;
      if (xi >= 0 && xi < n) s += w[j] * x[xi];
    }
    y[i] = s;
  }
  return y;
}

// 二参数最小二乘 y = a·x + b（numpy lstsq(A=[x,1], y) 的闭式解）
function lsq2(xs, ys) {
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
  }
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-300) return { a: 0, b: sy / n };
  const a = (n * sxy - sx * sy) / den;
  const b = (sy - a * sx) / n;
  return { a, b };
}

// Python round：银行家舍入（半数取偶），chroma 音级折叠必须同款
function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return (f % 2 === 0) ? f : f + 1;
}

function clip(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function median(sorted) {
  const n = sorted.length;
  if (n === 0) return NaN;
  const h = n >> 1;
  return n % 2 ? sorted[h] : 0.5 * (sorted[h - 1] + sorted[h]);
}

function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function maxAbs(arr) {
  let m = 0;
  for (let i = 0; i < arr.length; i++) { const a = Math.abs(arr[i]); if (a > m) m = a; }
  return m;
}

// ------------------------------------------------------------ 配置
export function defaultConfig() {
  return {
    fc: 8000.0,
    he: 16000.0,
    sr: 32000,
    n_fft: 2048,
    hop: 512,
    env_smooth_bins: 21,
    harmonics_max: 24,
    tonal_gate: true,
    gate_floor: 0.25,
    gate_ref: 0.15,
    selective: true,
    conf_threshold: 0.35,
    polyphony_max: 4,
    hb_skip_ratio: 1e-4,
    lat_gate_db: -1e9,
    noise_band: true,
    noise_rel_skip_db: -70.0,
    force_f0_mult: 1.0,
    rng_seed: 20261018,
  };
}

export const WOLA_WRITE_COMP = 1.5;
export const NOISE_WRITE_COMP = 1.3926;

// ------------------------------------------------------------ f0 估计（两遍）
function estimateF0(mag, freqs, fc, cfg) {
  const fLo = 55.0, fHi = fc / 2.0;
  const grid = geomspace(fLo, fHi, 360);
  const scores = new Float64Array(360);
  const band = Float64Array.from(mag);
  for (let i = 0; i < freqs.length; i++) if (freqs[i] > fc) band[i] = 0;
  let total = 1e-12;
  for (let i = 0; i < band.length; i++) total += band[i];
  let meanBand = 1e-12;
  for (let i = 1; i < band.length; i++) meanBand += band[i];
  meanBand = meanBand / (band.length - 1) + 1e-12;

  const slotMax = (lo, hi) => {
    const j0 = searchSortedLeft(freqs, lo);
    const j1 = searchSortedLeft(freqs, hi);
    if (j1 <= j0) return -Infinity;
    let m = -Infinity;
    for (let j = j0; j < j1; j++) if (band[j] > m) m = band[j];
    return m;
  };

  for (let i = 0; i < 360; i++) {
    const f0 = grid[i];
    let s = 0;
    let k = 1;
    while (k <= cfg.harmonics_max && k * f0 <= fc * 0.98) {
      const b = k * f0;
      const pk = slotMax(b * 0.99, b * 1.01);
      if (pk > 3.0 * meanBand) s += Math.sqrt(pk / total);
      k++;
    }
    scores[i] = s;
  }
  let sMax = -Infinity;
  for (let i = 0; i < 360; i++) if (scores[i] > sMax) sMax = scores[i];
  const cands = [];
  for (let i = 0; i < 360; i++) if (scores[i] >= sMax * 0.995) cands.push(i);

  const BGrid = [0.0, 1e-5, 3e-5, 1e-4, 3e-4, 8e-4, 2e-3];
  const candsHi = [];
  for (let i = 0; i < 360; i++) if (scores[i] >= sMax * 0.90) candsHi.push(i);
  const extra = candsHi.slice(-3);

  // linspace(0, len-1, min(4,len)).astype(int) 与 np 同（截断取整）
  const pickSet = new Set();
  const m = Math.min(4, cands.length);
  for (let i = 0; i < m; i++) {
    const pos = m === 1 ? 0 : Math.trunc((cands.length - 1) * i / (m - 1));
    pickSet.add(cands[pos]);
  }
  for (const e of extra) pickSet.add(e);
  const pick = Array.from(pickSet).sort((a, b) => b - a); // 高 f0 优先

  const scoreWarp = (fi, B) => {
    let s = 0;
    let k = 1;
    while (k <= cfg.harmonics_max) {
      const b = k * fi * Math.sqrt(1.0 + B * k * k);
      if (b > fc * 0.98) break;
      const pk = slotMax(Math.max(b * 0.99, 20.0), b * 1.01);
      if (pk > 3.0 * meanBand) s += Math.sqrt(pk / total);
      k++;
    }
    return s;
  };

  let bestS = -1.0;
  let bestF0 = grid[cands[cands.length - 1]];
  let bestB = 0.0;
  for (const i of pick) {
    const fi = grid[i];
    for (const B of BGrid) {
      const s = scoreWarp(fi, B);
      if (s > bestS + 1e-12) { bestS = s; bestF0 = fi; bestB = B; }
    }
  }
  const f0 = bestF0, inharmB = bestB;
  let meanScores = 0;
  for (let i = 0; i < 360; i++) meanScores += scores[i];
  meanScores /= 360;
  const sal = bestS / (meanScores + 1e-12);

  // 提取（不设条数帽，频率边界为准）
  const hfFreqs = [], hfAmps = [];
  let k = 1;
  while (k <= 512) {
    const b = k * f0 * Math.sqrt(1.0 + inharmB * k * k);
    if (b > fc * 0.98) break;
    const pk = slotMax(Math.max(b * 0.985, 20.0), b * 1.015);
    if (pk !== -Infinity) { hfFreqs.push(b); hfAmps.push(pk); }
    k++;
  }
  if (hfAmps.length === 0) {
    return { f0, sal, hfAmps: [], hfFreqs: [], interFrac: 1.0, inharmB, nHarmRes: 0 };
  }
  let peak = -Infinity;
  for (const a of hfAmps) if (a > peak) peak = a;
  const keepFreqs = [], keepAmps = [];
  for (let i = 0; i < hfAmps.length; i++) {
    if (hfAmps[i] > meanBand * 3.0 && hfAmps[i] > peak * 1e-2) {
      keepFreqs.push(hfFreqs[i]);
      keepAmps.push(hfAmps[i]);
    }
  }
  // 可分辨子集（捕获窗互不重叠）
  const resMask = [];
  let lastEnd = -1.0;
  for (let i = 0; i < keepFreqs.length; i++) {
    const w0 = keepFreqs[i] * 0.985, w1 = keepFreqs[i] * 1.015;
    if (w0 > lastEnd) { resMask.push(true); lastEnd = w1; }
    else resMask.push(false);
  }
  let nHarmRes = 0;
  for (const r of resMask) if (r) nHarmRes++;

  let sigP = 0.0;
  for (let i = 0; i < keepFreqs.length; i++) {
    if (!resMask[i]) continue;
    const hf = keepFreqs[i];
    const j = searchSortedLeft(freqs, hf);
    const j0 = Math.max(j - 2, 0), j1 = Math.min(j + 3, freqs.length);
    for (let q = j0; q < j1; q++) sigP += band[q] * band[q];
  }
  let interFrac = 1.0;
  if (nHarmRes > 0) {
    let lastRes = 0;
    for (let i = keepFreqs.length - 1; i >= 0; i--) {
      if (resMask[i]) { lastRes = keepFreqs[i]; break; }
    }
    const fResMax = lastRes * 1.015;
    let totP = 1e-30;
    for (let i = 1; i < freqs.length; i++) {
      if (freqs[i] <= fResMax) totP += band[i] * band[i];
    }
    interFrac = clip(1.0 - sigP / totP, 0.0, 1.0);
  }
  return { f0, sal, hfAmps: keepAmps, hfFreqs: keepFreqs, interFrac, inharmB, nHarmRes };
}

// ------------------------------------------------------------ 谐波格反衬
function latticeContrastDb(mag, freqs, f0, fc, inharmB) {
  const band = Float64Array.from(mag);
  for (let i = 0; i < freqs.length; i++) if (freqs[i] > fc) band[i] = 0;
  const warp = (kk) => kk * f0 * Math.sqrt(1.0 + inharmB * kk * kk);
  const slotMax = (lo, hi) => {
    const j0 = searchSortedLeft(freqs, lo);
    const j1 = searchSortedLeft(freqs, hi);
    if (j1 <= j0) return null;
    let m = -Infinity;
    for (let j = j0; j < j1; j++) if (band[j] > m) m = band[j];
    return m;
  };
  const slots = [], mids = [], midFs = [];
  let k = 1;
  while (k * f0 < fc * 0.95 && k <= 512) {
    const fk = warp(k);
    if (fk >= fc * 0.95) break;
    const fkMid = 0.5 * (fk + warp(k + 1));
    const sv = slotMax(Math.max(fk * 0.99, 20.0), fk * 1.01);
    if (sv !== null) slots.push(sv);
    const mv = slotMax(Math.max(fkMid * 0.99, 20.0), fkMid * 1.01);
    if (mv !== null) { mids.push(mv); midFs.push(fkMid); }
    k++;
  }
  if (slots.length < 3 || mids.length < 3) {
    return { contrast: NaN, midDbMed: NaN, midF: NaN, slotDb: NaN, nAnti: 0, midStd: NaN };
  }
  const eps = 1e-12;
  let slotSum = 0;
  for (const s of slots) slotSum += Math.log10(s + eps);
  const slotDb = (20 * slotSum) / slots.length;
  const midDbArr = mids.map((v) => 20 * Math.log10(v + eps));
  const midDbMed = median(Float64Array.from(midDbArr).sort());
  const midFSorted = Float64Array.from(midFs).sort();
  const midF = median(midFSorted);
  const mm = mean(midDbArr);
  let vs = 0;
  for (const v of midDbArr) vs += (v - mm) * (v - mm);
  const midStd = Math.sqrt(vs / midDbArr.length);
  return { contrast: slotDb - mm, midDbMed, midF, slotDb, nAnti: mids.length, midStd };
}

// ------------------------------------------------------------ 乐理门
function chromaFromHarmonics(freqsArr, ampsArr) {
  const c = new Float64Array(12);
  for (let i = 0; i < freqsArr.length; i++) {
    const f = freqsArr[i];
    if (f <= 0) continue;
    const pc = ((roundHalfEven(69 + 12 * Math.log2(f / 440.0)) % 12) + 12) % 12;
    c[pc] += ampsArr[i];
  }
  let s = 0;
  for (let i = 0; i < 12; i++) s += c[i];
  if (s > 0) for (let i = 0; i < 12; i++) c[i] /= s;
  return c;
}

function tonalGateWeight(partialFreq, chroma, cfg) {
  let s = 0, mx = -Infinity;
  for (let i = 0; i < 12; i++) { s += chroma[i]; if (chroma[i] > mx) mx = chroma[i]; }
  if (s <= 0) return 1.0;
  const pc = ((roundHalfEven(69 + 12 * Math.log2(partialFreq / 440.0)) % 12) + 12) % 12;
  const rel = chroma[pc] / (mx + 1e-12);
  return cfg.gate_floor + (1 - cfg.gate_floor) * Math.min(rel / cfg.gate_ref, 1.0);
}

// ------------------------------------------------------------ 峰值选取
function peakPick(freqs, mag, minPromRatio = 1.0, k = 5) {
  const n = mag.length;
  let s = 0;
  for (let i = 1; i < n; i++) s += mag[i];
  const meanMag = s / (n - 1) + 1e-12;
  const out = [];
  for (let i = 2; i < n - 2; i++) {
    const a = mag[i - 2], b = mag[i - 1], c = mag[i], d = mag[i + 1], e = mag[i + 2];
    if (b >= a && b >= c && b > d && b > e && b > meanMag * minPromRatio) {
      const denom = a - 2 * b + c;
      let delta = Math.abs(denom) > 1e-15 ? 0.5 * (a - c) / denom : 0.0;
      delta = clip(delta, -0.5, 0.5);
      out.push({ f: freqs[i - 1] + delta * (freqs[1] - freqs[0]), m: b });
    }
  }
  out.sort((p, q) => q.m - p.m);
  const ff = [], mm = [];
  for (let i = 0; i < Math.min(k, out.length); i++) { ff.push(out[i].f); mm.push(out[i].m); }
  return { freqs: ff, mags: mm };
}

// ------------------------------------------------------------ 置信度
function frameConfidence(p) {
  const { sal, nHarm, envFitDb, f0, fc, interFrac, tailDbRel, midStd, nAnti, noiseEligible, inharmB } = p;
  const c1 = Math.min(sal / 8.0, 1.0);
  const c2 = Math.exp(-envFitDb / 6.0);
  const c3 = Math.min(nHarm / 8.0, 1.0);
  const reg = Math.log2(fc / Math.max(f0, 1.0)) / 4.0;
  const c4 = Math.min(Math.max(reg, 0.0), 1.0);
  const base = 0.30 * c1 + 0.25 * c2 + 0.25 * c3 + 0.20 * c4;
  const cEvid = Math.exp(-8.0 * interFrac);
  const cTail = clip((tailDbRel + 90.0) / 50.0, 0.0, 1.0);
  const cB = Math.exp(-Math.max(inharmB, 0.0) / 5e-4);
  const cHarm = clip(cEvid * (0.5 + 0.5 * cTail) * cB * base, 0.0, 1.0);
  let cNoise = 0.0;
  if (noiseEligible && nAnti >= 6 && Number.isFinite(midStd)) {
    const cFloor = clip(1.0 - midStd / 15.0, 0.0, 1.0);
    const cMeas = Math.min(nAnti / 12.0, 1.0);
    cNoise = clip(0.7 * cFloor * cMeas, 0.0, 0.7);
  }
  return Math.max(cHarm, cNoise);
}

// ------------------------------------------------------------ 残差高通
function highpassFft(x, fc, sr, taper = 0.05) {
  const n = x.length;
  const X = rfftFull(x);
  const f = rfftfreq(n, sr);
  const g = new Float64Array(X.re.length);
  const t0 = fc * (1 - taper), t1 = fc;
  for (let i = 0; i < g.length; i++) {
    const fi = f[i];
    if (fi < t0) g[i] = 0;
    else if (fi >= t1) g[i] = 1;
    else g[i] = 0.5 * (1 - Math.cos(Math.PI * (fi - t0) / (t1 - t0)));
  }
  const Yr = new Float64Array(g.length), Yi = new Float64Array(g.length);
  for (let i = 0; i < g.length; i++) { Yr[i] = X.re[i] * g[i]; Yi[i] = X.im[i] * g[i]; }
  return irfftFull({ re: Yr, im: Yi }, n);
}

// ------------------------------------------------------------ 信号级直通守卫比值
export function highBandEnergyRatio(x, sr, fc, he) {
  const X = rfftFull(x);
  const f = rfftfreq(x.length, sr);
  let eHi = 0, eAll = 1e-30;
  for (let i = 0; i < X.re.length; i++) {
    const p = X.re[i] * X.re[i] + X.im[i] * X.im[i];
    if (f[i] > fc * 1.005 && f[i] <= he) eHi += p;
    if (i >= 1) eAll += p;
  }
  return eHi / eAll;
}

// ------------------------------------------------------------ 主入口
export function restore(xIn, cfg, onProgress) {
  const cfgUse = { ...defaultConfig(), ...(cfg || {}) };
  const x = Float64Array.from(xIn);
  const stft = new STFT(cfgUse.n_fft, cfgUse.hop);
  const S = stft.analysis(x);
  const freqs = rfftfreq(cfgUse.n_fft, cfgUse.sr);
  const nFrames = S.nFrames;
  const nBins = S.nBins;
  const FC = cfgUse.fc, HE = cfgUse.he;

  // 信号级全带直通守卫
  const guardRatio = highBandEnergyRatio(x, cfgUse.sr, FC, HE);
  if (guardRatio > cfgUse.hb_skip_ratio) {
    const diag = {
      conf: new Float64Array(nFrames).fill(1),
      f0: new Float64Array(nFrames).fill(NaN),
      abstained: new Uint8Array(nFrames),
      gateMean: new Float64Array(nFrames),
      passthrough: new Uint8Array(nFrames).fill(1),
      lat: new Float64Array(nFrames).fill(NaN),
      noiseBand: new Float64Array(nFrames),
      nFrames,
      coverage: 1.0,
      signalPassthrough: true,
      guardRatio,
    };
    return { y: Float64Array.from(x), diag };
  }

  const Yr = Float64Array.from(S.re);
  const Yi = Float64Array.from(S.im);
  const confs = new Float64Array(nFrames);
  const f0s = new Float64Array(nFrames);
  const abstained = new Uint8Array(nFrames);
  const gateStats = new Float64Array(nFrames);
  const passthrough = new Uint8Array(nFrames);
  const latStats = new Float64Array(nFrames).fill(NaN);
  const noiseStats = new Float64Array(nFrames);

  const jFc = searchSortedLeft(freqs, FC);
  const jHe = Math.min(searchSortedLeft(freqs, HE), freqs.length);

  // 边缘帧有效样本占比
  const sig0 = stft._head, sig1 = stft._head + x.length;
  const edgeInvalid = new Uint8Array(nFrames);
  for (let t = 0; t < nFrames; t++) {
    const fs = t * cfgUse.hop;
    const fe = fs + cfgUse.n_fft;
    const ov = clip(Math.min(fe, sig1) - Math.max(fs, sig0), 0, cfgUse.n_fft);
    if (ov / cfgUse.n_fft < 0.5) edgeInvalid[t] = 1;
  }

  // 写入相位表（共享 PRNG，逐位同 make_assets.py）
  const nNb = Math.max(jHe - jFc - 1, 0);
  const rng = new Mulberry32BoxMuller(cfgUse.rng_seed);
  const harmPh0 = rng.uniformArr(jHe);
  const noisePh0 = rng.uniformArr(nNb);
  const noiseAmpT = nNb ? rng.normal2d(nFrames, nNb) : null;
  const nbJidx = new Int32Array(nNb);
  for (let i = 0; i < nNb; i++) nbJidx[i] = jFc + 1 + i;

  const rowStride = nBins;
  for (let t = 0; t < nFrames; t++) {
    const mag = new Float64Array(nBins);
    const P = new Float64Array(nBins);
    for (let j = 0; j < nBins; j++) {
      const re = S.re[t * rowStride + j], im = S.im[t * rowStride + j];
      const a = Math.hypot(re, im);
      mag[j] = a;
      P[j] = a * a;
    }

    const est = estimateF0(mag, freqs, FC, cfgUse);
    let { f0, sal, hfAmps, hfFreqs, interFrac, inharmB, nHarmRes } = est;
    if (cfgUse.force_f0_mult !== 1.0) f0 *= cfgUse.force_f0_mult;
    f0s[t] = f0;

    const lat = latticeContrastDb(mag, freqs, f0, FC, inharmB);
    latStats[t] = lat.contrast;
    const noiseEligible = Boolean(cfgUse.noise_band && Number.isFinite(lat.midDbMed)
      && lat.midDbMed > lat.slotDb + cfgUse.noise_rel_skip_db);

    let envFitDb = 10.0;
    let tailDbRel = -90.0;
    let slopeT = 0.0, anchorDb = null, anchorF = null;
    let coefA = 0;
    if (hfFreqs.length >= 3) {
      const lx = new Float64Array(hfFreqs.length);
      const ly = new Float64Array(hfFreqs.length);
      for (let i = 0; i < hfFreqs.length; i++) {
        lx[i] = Math.log2(hfFreqs[i]);
        ly[i] = 20 * Math.log10(hfAmps[i] + 1e-12);
      }
      const coef = lsq2(lx, ly);
      coefA = coef.a;
      let ss = 0;
      for (let i = 0; i < lx.length; i++) {
        const r = ly[i] - (coef.a * lx[i] + coef.b);
        ss += r * r;
      }
      envFitDb = Math.sqrt(ss / lx.length);

      // 带顶八度包络斜率（第十二轮口径）
      const mEdgeIdx = [];
      for (let j = 0; j < freqs.length; j++) {
        if (freqs[j] >= FC * 0.5 && freqs[j] < FC) mEdgeIdx.push(j);
      }
      if (mEdgeIdx.length >= 8) {
        const wOct = Math.max(cfgUse.env_smooth_bins,
          Math.round(f0 * cfgUse.n_fft / cfgUse.sr) + 1);
        const kw = new Float64Array(wOct).fill(1 / wOct);
        const envOct = convSame(P, kw);
        const lxe = new Float64Array(mEdgeIdx.length);
        const lye = new Float64Array(mEdgeIdx.length);
        for (let i = 0; i < mEdgeIdx.length; i++) {
          lxe[i] = Math.log2(freqs[mEdgeIdx[i]]);
          lye[i] = 10 * Math.log10(envOct[mEdgeIdx[i]] + 1e-18);
        }
        slopeT = Math.min(lsq2(lxe, lye).a, 0.0);
      } else {
        slopeT = Math.min(coefA, 0.0);
      }
      const lastLx = ly[ly.length - 1];
      const lastF = hfFreqs[hfFreqs.length - 1];
      tailDbRel = lastLx + slopeT * Math.log2(HE / Math.max(lastF, 1.0)) - ly[0];
      anchorDb = lastLx;
      anchorF = lastF;
    }

    const conf = frameConfidence({
      sal, nHarm: nHarmRes, envFitDb, f0, fc: FC, interFrac, tailDbRel,
      midStd: lat.midStd, nAnti: lat.nAnti, noiseEligible, inharmB,
    });
    confs[t] = conf;

    if (edgeInvalid[t]) { abstained[t] = 1; continue; }
    if (cfgUse.selective && conf < cfgUse.conf_threshold) { abstained[t] = 1; continue; }
    if (hfFreqs.length < 3 || f0 < 40 || interFrac > 0.6
        || anchorF === null || anchorF < FC * 0.5) {
      abstained[t] = 1;
      continue;
    }
    if (cfgUse.selective && (!Number.isFinite(lat.contrast) || lat.contrast < cfgUse.lat_gate_db)) {
      abstained[t] = 1; continue;
    }

    // chroma 从实际谱峰构建
    const pk = peakPick(freqs, mag, 2.0, 16);
    const pf = [], pa = [];
    for (let i = 0; i < pk.freqs.length; i++) {
      if (pk.freqs[i] < FC) { pf.push(pk.freqs[i]); pa.push(pk.mags[i]); }
    }
    const chroma = chromaFromHarmonics(pf, pa);
    const slope = slopeT;

    let gwSum = 0, gwN = 0;
    let k = Math.ceil(FC / f0);
    while (k <= 512) {
      const fk = k * f0 * Math.sqrt(1.0 + inharmB * k * k);
      if (fk >= HE) break;
      const j = searchSortedLeft(freqs, fk);
      if (j >= jHe) break;
      if (j > jFc) {
        const ampDb = anchorDb + slope * Math.log2(fk / anchorF);
        const amp = Math.pow(10, ampDb / 20.0);
        let w = 1.0;
        if (cfgUse.tonal_gate) {
          w = tonalGateWeight(fk, chroma, cfgUse);
          gwSum += w; gwN++;
        }
        const ph = harmPh0[j] + 2.0 * Math.PI * j * (t * cfgUse.hop) / cfgUse.n_fft;
        const v = amp * w * WOLA_WRITE_COMP;
        Yr[t * rowStride + j] = v * Math.cos(ph);
        Yi[t * rowStride + j] = v * Math.sin(ph);
      }
      k++;
    }
    gateStats[t] = gwSum / Math.max(gwN, 1);

    // 噪声带延拓
    if (noiseEligible && nNb) {
      const fks = new Float64Array(nNb);
      for (let i = 0; i < nNb; i++) fks[i] = freqs[jFc + 1 + i];
      const midF = Math.max(lat.midF, 1e-9);
      const rowOff = t * nNb;
      for (let i = 0; i < nNb; i++) {
        const tilt = slope * Math.log2(Math.max(fks[i], 1.0) / midF);
        const base = Math.pow(10, (lat.midDbMed + tilt) / 20.0);
        const ph = noisePh0[i] + 2.0 * Math.PI * nbJidx[i] * (t * cfgUse.hop) / cfgUse.n_fft;
        const v = base * noiseAmpT[rowOff + i] * NOISE_WRITE_COMP;
        const jj = jFc + 1 + i;
        Yr[t * rowStride + jj] += v * Math.cos(ph);
        Yi[t * rowStride + jj] += v * Math.sin(ph);
      }
      noiseStats[t] = 1.0;
    }

    if (onProgress && (t & 15) === 15) onProgress(t + 1, nFrames);
  }

  const yRaw = stft.synthesis({ re: Yr, im: Yi, nFrames, nBins }, x.length);
  const residual = highpassFft(
    Float64Array.from(yRaw, (v, i) => v - x[i]), FC, cfgUse.sr);
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] + residual[i];

  let nAbstain = 0;
  for (let t = 0; t < nFrames; t++) if (abstained[t]) nAbstain++;
  const diag = {
    conf: confs, f0: f0s, abstained, gateMean: gateStats, passthrough,
    lat: latStats, noiseBand: noiseStats,
    nFrames,
    coverage: 1.0 - nAbstain / nFrames,
    signalPassthrough: false,
    guardRatio,
  };
  if (onProgress) onProgress(nFrames, nFrames);
  return { y, diag };
}

// ------------------------------------------------------------ 对拍指标（论文口径）
export function lsdHighbandEnv(y, gt, cfg) {
  const c = { ...defaultConfig(), ...(cfg || {}) };
  const stft = new STFT(c.n_fft, c.hop);
  const Sy = stft.analysis(Float64Array.from(y));
  const Sg = stft.analysis(Float64Array.from(gt));
  const freqs = rfftfreq(c.n_fft, c.sr);
  const df = freqs[1] - freqs[0];
  const wFrac = Math.pow(2, 1 / 6) - 1;
  const fQ = geomspace(c.fc * 1.02, Math.min(c.he, c.sr / 2) * 0.98, 48);
  const n = Sy.nFrames;
  const stride = Sy.nBins;
  const envAt = (S) => {
    const out = new Float64Array(n * 48);
    for (let qi = 0; qi < 48; qi++) {
      const fq = fQ[qi];
      const bw = Math.max(fq * wFrac, df);
      const idx = [];
      for (let j = 0; j < freqs.length; j++) {
        if (Math.abs(freqs[j] - fq) <= bw / 2) idx.push(j);
      }
      for (let t = 0; t < n; t++) {
        let s = 0;
        for (const j of idx) {
          const re = S.re[t * stride + j], im = S.im[t * stride + j];
          s += re * re + im * im;
        }
        out[t * 48 + qi] = Math.log10(s / idx.length + 1e-16);
      }
    }
    return out;
  };
  const Ey = envAt(Sy), Eg = envAt(Sg);
  let acc = 0;
  for (let t = 0; t < n; t++) {
    let ss = 0;
    for (let q = 0; q < 48; q++) {
      const d = 10 * Ey[t * 48 + q] - 10 * Eg[t * 48 + q];
      ss += d * d;
    }
    acc += Math.sqrt(ss / 48);
  }
  return acc / n;
}

export function identityLowbandDb(y, x, cfg) {
  const c = { ...defaultConfig(), ...(cfg || {}) };
  const stft = new STFT(c.n_fft, c.hop);
  const Sy = stft.analysis(Float64Array.from(y));
  const Sx = stft.analysis(Float64Array.from(x));
  const freqs = rfftfreq(c.n_fft, c.sr);
  let eLeak = 0, eRef = 1e-30;
  const stride = Sy.nBins;
  for (let t = 0; t < Sy.nFrames; t++) {
    for (let j = 0; j < freqs.length; j++) {
      if (freqs[j] >= c.fc) continue;
      const dr = Sy.re[t * stride + j] - Sx.re[t * stride + j];
      const di = Sy.im[t * stride + j] - Sx.im[t * stride + j];
      eLeak += dr * dr + di * di;
      eRef += Sx.re[t * stride + j] ** 2 + Sx.im[t * stride + j] ** 2;
    }
  }
  return 10 * Math.log10(eLeak / eRef + 1e-30);
}
