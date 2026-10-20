// 整数比多相重采样（scipy.signal.resample_poly 同配方）：
// 会话采样率 <-> 算法固定 32k。Kaiser(beta=5) 线性相位 FIR，
// 群延迟在输出端显式补偿。不做逐样本 scipy 对拍：产品路径不参与
// 32k 对拍（演示素材本身就是 32k），此模块只保证往返无 audible 伪影。

function i0(x) {
  let s = 1, t = 1;
  const h = x / 2;
  for (let k = 1; k < 40; k++) {
    t *= (h * h) / (k * k);
    s += t;
    if (t < 1e-17 * s) break;
  }
  return s;
}

// firwin 低通（numtaps 奇数，cutoff 以 Nyquist 为 1），Kaiser 窗，DC 增益归一
function firLowpass(numTaps, cutoffNyq, beta = 5.0) {
  const M = numTaps - 1;
  const alpha = M / 2;
  const h = new Float64Array(numTaps);
  const wDen = i0(beta);
  for (let n = 0; n < numTaps; n++) {
    const m = n - alpha;
    const sinc = m === 0 ? cutoffNyq : Math.sin(Math.PI * cutoffNyq * m) / (Math.PI * m);
    const r = m / alpha;
    const w = i0(beta * Math.sqrt(Math.max(1 - r * r, 0))) / wDen;
    h[n] = sinc * w;
  }
  // 低通 scale：2*fc（Nyquist 单位），使通带增益为 1
  let sum = 0;
  for (let n = 0; n < numTaps; n++) sum += h[n];
  // DC 响应 = sum；目标 1 → 除以 sum（等价 firwin 的 scale）
  const g = 1 / (sum || 1);
  for (let n = 0; n < numTaps; n++) h[n] *= g;
  return h;
}

function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }

/**
 * 多相重采样。y[n] = Σ_m x[m]·h[n·down + dly − m·up]，h 为线性相位 FIR，
 * dly=(L−1)/2 补偿群延迟。nOut 可指定输出长度（尾部截断/零填），
 * 用于往返后与原会话长度对齐。
 */
export function resamplePoly(xIn, srIn, srOut, nOutWant) {
  if (srIn === srOut) {
    const y = nOutWant !== undefined && nOutWant !== xIn.length
      ? fitLength(Float64Array.from(xIn), nOutWant)
      : Float64Array.from(xIn);
    return y;
  }
  const g = gcd(srIn, srOut);
  const up = srOut / g;
  const down = srIn / g;
  const maxRate = Math.max(up, down);
  const halfLen = 10 * maxRate;                       // scipy resample_poly 默认
  const numTaps = 2 * halfLen + 1;
  // scipy resample_poly 配方：cutoff = 1/max_rate（Nyquist 单位，相对
  // 升采样后域），落在 min(fs_in,fs_out)/2，双侧都过 16k 保护带
  const h = firLowpass(numTaps, 1.0 / maxRate);
  const L = numTaps;
  const dly = (L - 1) >> 1;
  const x = Float64Array.from(xIn);
  const nIn = x.length;
  const nOut = nOutWant !== undefined ? nOutWant : Math.ceil((nIn * up) / down);
  const y = new Float64Array(nOut);

  for (let n = 0; n < nOut; n++) {
    const base = n * down + dly;
    // m 满足 0 ≤ base − m·up ≤ L−1
    let m0 = Math.ceil((base - (L - 1)) / up);
    if (m0 < 0) m0 = 0;
    let m1 = Math.floor(base / up);
    if (m1 > nIn - 1) m1 = nIn - 1;
    let s = 0;
    for (let m = m0; m <= m1; m++) s += x[m] * h[base - m * up];
    y[n] = s * up;
  }
  return y;
}

function fitLength(x, n) {
  if (x.length === n) return x;
  const y = new Float64Array(n);
  y.set(x.subarray(0, Math.min(n, x.length)));
  return y;
}

// 会话采样率 -> 32k
export function toInternal32k(x, srSession) {
  return resamplePoly(x, srSession, 32000);
}

// 32k -> 会话采样率（长度对齐原信号）
export function fromInternal32k(x, srSession, nOut) {
  return resamplePoly(x, 32000, srSession, nOut);
}
