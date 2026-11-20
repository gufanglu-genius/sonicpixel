/* ============================================================
   初团 · 批次9/10 真实采样音源
   ------------------------------------------------------------
   构建期由 tools/extract_sf2.py 从 FluidR3_GM 音色库一次性抽出
   13 个旋律音色与 6 件鼓采样（assets/timbre/ 下 WAV + manifest.json，
   带分区、循环点、音高微调、音量包络、声像与互斥类元数据）。本文件
   负责在浏览器加载这些采样，并按 SF2 / fluidsynth 语义调度发声：

   - 分区选取：keyRange + velRange 过滤，命中的分区全部发声
     （fluidsynth noteon 同构：立体声孪生左右两区各带分区 pan
     硬像成像），一区不中回落单区语义（音区外取最近分区硬移调）；
   - 声像：分区 pan（−500..500）经 StereoPanner 等功率律归一，
     硬像端与 fluidsynth fluid_pan 同为 (1,0)/(0,1)；
   - 音高换算：playbackRate = 2^((midi - root + tune/100) / 12)；
   - 循环播放：loopStart/loopEnd 取自抽样时的循环点（秒）；
   - 音量包络：按 SF2 延迟/起音/保持/衰减/延持/释音生成
     setValueCurveAtTime 曲线，释音封顶 R_CAP 秒防连奏糊成一片；
   - 滤波：SF2 initialFilterFc/Q 与 modEnvToFilterFc 按 fluidsynth
     同式折成低通（BiquadFilterNode，Q 单位 dB），扫频时铺
     modEnv 曲线；滤波按 1/√Q 的补偿增益折进音量峰值；
   - 鼓件单次触发，±1.5% 播放速率微差防「机关枪」效应；
     exclusiveClass≠0（闭镲/开镲为 1）掐掉异组同类旧声：min
     note length 10ms 后起 0.891s 释音（fluidsynth kill_excl 同参，
     cB 线性斜率），同一次触发的孪生分区共享组号互不掐。

   加载失败或 node 环境下保持未就绪，band.js 按事件逐个回退到
   原合成路径（scheduleVoice/scheduleDrum 返回 false 即回退），
   整次渲染要么全程采样、要么全程合成，不做半采样混搭。
   ============================================================ */
(function (global) {
  'use strict';

  const BASE = 'assets/timbre/';
  // 释音封顶（秒）：FluidR3 钢琴释音 1 秒、钟琴可达 7 秒，十六分音符
  // 连奏时长尾叠长尾必糊（批次6 治过的同款病），封顶保音乐性；
  // 这是按作品语境的取舍，不是 SF2 原样回放。
  const R_CAP = 1.8;
  const VOICE_K = 0.7;        // 旋律采样响度基准（att × 力度 × 此值）
  const DRUM_K = 0.55;        // 鼓采样响度基准，与合成路径同口径
  const LOAD_CONCURRENCY = 8; // 同时拉取的 WAV 数

  const state = {
    status: 'idle',           // idle | loading | ready | failed
    manifest: null,
    buffers: new Map(),       // 文件名 → { sr, pcm:Float32Array }
    abCache: new Map(),       // 文件名 → AudioBuffer（跨渲染上下文复用）
    promise: null,
    error: null,
  };

  /* ---------- 纯函数：WAV 解析（仅本管线产物：单声道 PCM16 RIFF） ---------- */
  function parseWav(ab) {
    const dv = new DataView(ab);
    const tag = (o) => String.fromCharCode(
      dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    if (dv.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
      throw new Error('不是 WAV（RIFF/WAVE 头缺失）');
    }
    let pos = 12, fmt = null, dataOff = -1, dataSize = 0;
    while (pos + 8 <= dv.byteLength) {
      const id = tag(pos);
      const size = dv.getUint32(pos + 4, true);
      const body = pos + 8;
      if (body + size > dv.byteLength) break;
      if (id === 'fmt ') {
        fmt = {
          format: dv.getUint16(body, true),
          channels: dv.getUint16(body + 2, true),
          sampleRate: dv.getUint32(body + 4, true),
          bits: dv.getUint16(body + 14, true),
        };
      } else if (id === 'data') {
        dataOff = body;
        dataSize = size;
      }
      pos = body + size + (size & 1);
    }
    if (!fmt || dataOff < 0) throw new Error('WAV 缺 fmt/data 块');
    if (fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16) {
      throw new Error('仅支持单声道 PCM16');
    }
    const n = dataSize >> 1;
    const pcm = new Float32Array(n);
    for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(dataOff + i * 2, true) / 32768;
    return { sr: fmt.sampleRate, pcm };
  }

  /* ---------- 纯函数：分区选取 ----------
     zones 按 (lo, velLo) 升序（抽取器已排）。命中顺序：
     音区+力度都中 → 直接用；音区中力度不中 → 音区首个（力度差由增益体现）；
     音区外（理论上不发生）→ 距离最近的分区硬移调，避免音色跳变回合成。 */
  function pickZone(zones, midi, vel) {
    if (!zones || !zones.length) return null;
    let inKey = null, nearest = null, best = Infinity;
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      if (midi >= z.lo && midi <= z.hi) {
        if (vel >= z.velLo && vel <= z.velHi) return z;
        if (!inKey) inKey = z;
        continue;
      }
      const d = midi < z.lo ? z.lo - midi : midi - z.hi;
      if (d < best) { best = d; nearest = z; }
    }
    return inKey || nearest;
  }

  /* ---------- 纯函数：覆盖分区（fluidsynth noteon 同构） ----------
     返回 key 与 vel 全部命中的分区：立体声孪生两区同在（各带分区
     pan 硬像），力度分带同理只命中所属分带；一区不中回落 pickZone
     的单区语义（力度差由增益体现、音区外取最近硬移调）。 */
  function coverZones(zones, midi, vel) {
    const hits = [];
    if (zones) {
      for (let i = 0; i < zones.length; i++) {
        const z = zones[i];
        if (midi >= z.lo && midi <= z.hi && vel >= z.velLo && vel <= z.velHi) {
          hits.push(z);
        }
      }
    }
    if (hits.length) return hits;
    const z = pickZone(zones, midi, vel);
    return z ? [z] : [];
  }

  /* ---------- 纯函数：音高换算 ---------- */
  function rateOf(zone, midi) {
    return Math.pow(2, ((midi - zone.root) + (zone.tune || 0) / 100) / 12);
  }

  /* ---------- 纯函数：滤波器（fluidsynth 逐式对齐） ----------
     ct2hz：fluid_conv.c fluid_ct2hz，分音先钳 [1500,13500]
     （≈20Hz 到 20kHz）再 440·2^((c−6900)/1200)；调度侧再钳
     [5, 0.45·sr]（iir.c fluid_iir_filter_calc 同口径）。
     Q：SF2 存 cB。WebAudio 规范低通 Q 单位为 dB 且
     α=sinω/(2·10^(Q/20))，fluidsynth q_lin=10^((fq/10−3.01)/20)，
     两式恒等，故 Q_dB = fq/10 − 3.01（0 cB → −3.01 dB → Q=0.707）。
     增益：fluidsynth 按 SF2.01 把 1/√q_lin 折进 b 系数；线性系统
     与后续增益相乘可交换，直接折进音量峰值，数学等价。
     fluid_convex：modEnv 起音段整形（gen_conv.c 表值
     1−(400/960)·log10(127/i)，整数点间线性插值，PEAK_ATTENUATION=960）。 */
  function ct2hz(cents) {
    const c = cents >= 13500 ? 13500 : (cents < 1500 ? 1500 : cents);
    return 440 * Math.pow(2, (c - 6900) / 1200);
  }
  function filterQDb(zone) {
    return (zone.fq || 0) / 10 - 3.01;
  }
  function filterGain(zone) {
    if (zone.fc == null) return 1;
    return Math.pow(10, (3.01 - (zone.fq || 0) / 10) / 40);   // 1/√q_lin
  }
  function convex(v) {
    if (v <= 0) return 0;
    if (v >= 127) return 1;
    const i = Math.floor(v);
    const tab = (j) => (j <= 0 ? 0
      : j >= 127 ? 1
        : 1 - (400 / 960) * Math.log10(127 / j));
    const a = tab(i), b = tab(i + 1);
    return a + (b - a) * (v - i);
  }

  /* ---------- 纯函数：modEnv 任意时刻值 ----------
     fluid_adsr_env_calc 逐段线性：延迟 0 → 起音线性升（起音段
     另经 fluid_convex 整形）→ 保持 1 → 衰减线性降到 sus →
     延持；松手（rel 时刻）后以 −1/r 斜率线性归零，起始值低则
     提前走完（斜率与起始值无关，同 fluidsynth）。 */
  function menvAt(e, x, rel) {
    const d = e.d || 0, a = e.a || 0, h = e.h || 0, dec = e.dec || 0;
    const sus = e.sus == null ? 1 : e.sus;
    const r = e.r > 0 ? e.r : 0.001;
    const pre = (t) => {
      if (t <= d) return 0;
      let y = t - d;
      if (y < a) return a > 0 ? convex(127 * (y / a)) : 1;
      y -= a;
      if (y < h) return 1;
      y -= h;
      if (dec > 0 && y < dec) return 1 + (sus - 1) * (y / dec);
      return sus;
    };
    if (x <= rel) return pre(x);
    return Math.max(0, pre(rel) - (x - rel) / r);
  }

  /* ---------- 纯函数：音量包络曲线 ----------
     SF2 语义：线性起音 → 保持 → 指数衰减到延持电平 → 延持到符尾
     （dur）→ 指数释音到 0。返回 { values:Float32Array, duration:秒 }，
     供 setValueCurveAtTime(values, t, duration) 一次铺完，曲线终点归零。 */
  function envCurve(env, dur, sr) {
    const a = Math.max(0.0005, env.a || 0.0005);
    const h = Math.max(0, env.h || 0);
    const dec = Math.max(0.001, env.dec || 0.001);
    const sus = Math.min(1, Math.max(0.0001, env.sus == null ? 1 : env.sus));
    const r = Math.max(0.01, Math.min(env.r == null ? 0.2 : env.r, R_CAP));
    const relStart = Math.max(0.005, dur);
    const total = relStart + r;
    // 每秒 500 点（上限 4096）：毫秒级分辨率足够，曲线越短点距越密
    const N = Math.min(4096, Math.max(64, Math.ceil(total * 500) + 1));
    const values = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (total * i) / (N - 1);
      let v;
      if (x < a) v = x / a;
      else if (x < a + h) v = 1;
      else {
        const dx = x - a - h;
        v = dx < dec ? sus + (1 - sus) * Math.pow(0.001, dx / dec) : sus;
      }
      if (x > relStart) {
        const dr = (x - relStart) / r;
        v = dr >= 1 ? 0 : v * Math.pow(0.001, dr);
      }
      values[i] = v;
    }
    values[N - 1] = 0;
    return { values, duration: total };
  }

  /* ---------- AudioBuffer 构造（同文件只转一次，跨渲染上下文复用） ---------- */
  function audioBufferFor(file, ctx) {
    let ab = state.abCache.get(file);
    if (ab) return ab;
    const raw = state.buffers.get(file);
    if (!raw || !raw.pcm || !raw.pcm.length || !raw.sr) return null;
    ab = ctx.createBuffer(1, raw.pcm.length, raw.sr);
    ab.copyToChannel(raw.pcm, 0);
    state.abCache.set(file, ab);
    return ab;
  }

  /* ---------- WebAudio：滤波级挂链（src → [低通] → 增益） ----------
     重采样之后挂绝对 Hz 的低通，与 fluidsynth（voice DSP 内滤波）
     顺序一致。fc 缺失（旧 manifest）直连不滤；m2fc=0 静态截止；
     非零则与音量包络同起点、同总时长铺扫频曲线，rel 为松手时刻。 */
  function connectFilter(ctx, src, dest, zone, t, total, rel) {
    if (zone.fc == null) { src.connect(dest); return; }
    const hi = 0.45 * ctx.sampleRate;
    const hz = (c) => Math.min(hi, Math.max(5, ct2hz(c)));
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = filterQDb(zone);
    const m2fc = zone.m2fc || 0;
    if (!m2fc || !zone.menv) {
      filt.frequency.value = hz(zone.fc);
    } else {
      // 5ms 点距（上限 2048 点）：扫频最短衰减 0.25s 也有 50 个采样点
      const N = Math.min(2048, Math.max(64, Math.ceil(total * 200) + 1));
      const arr = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const x = (total * i) / (N - 1);
        arr[i] = hz(zone.fc + m2fc * menvAt(zone.menv, x, rel));
      }
      filt.frequency.setValueCurveAtTime(arr, t, total);
    }
    src.connect(filt);
    filt.connect(dest);
  }

  /* ---------- WebAudio：单个旋律分区发声（声像按分区 pan 挂链） ---------- */
  function startVoice(ctx, master, zone, midi, t, dur, vel, rnd) {
    const buf = audioBufferFor(zone.file, ctx);
    if (!buf) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rateOf(zone, midi);
    if (zone.loop && zone.loop[1] > zone.loop[0]) {
      src.loop = true;
      src.loopStart = zone.loop[0] / buf.sampleRate;
      src.loopEnd = zone.loop[1] / buf.sampleRate;
    }
    // 响度：SF2 初始衰减 × 力度 × 基准 × 滤波补偿（1/√Q），
    // 附逐音微变防机械感
    const att = zone.att == null ? 1 : zone.att;
    const peak = (vel / 127) * att * VOICE_K * filterGain(zone)
      * (0.96 + rnd() * 0.08);
    const curve = envCurve({
      a: zone.env.a, h: zone.env.h, dec: zone.env.dec,
      sus: zone.env.sus, r: Math.min(zone.env.r == null ? 0.2 : zone.env.r, R_CAP),
    }, dur, buf.sampleRate);
    const values = new Float32Array(curve.values.length);
    for (let i = 0; i < values.length; i++) values[i] = curve.values[i] * peak;
    const g = ctx.createGain();
    g.gain.setValueCurveAtTime(values, t, curve.duration);
    connectFilter(ctx, src, g, zone, t, curve.duration, Math.max(0.005, dur));
    if (zone.pan) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, zone.pan / 500));
      g.connect(panner);
      panner.connect(master);
    } else {
      g.connect(master);
    }
    src.start(t);
    src.stop(t + curve.duration);
    return true;
  }

  /* ---------- WebAudio 调度：旋律音（覆盖分区全部发声） ---------- */
  function scheduleVoice(ctx, master, inst, midi, t, dur, vel, rnd) {
    if (state.status !== 'ready') return false;
    const pack = state.manifest.instruments[inst];
    if (!pack) return false;
    const zones = coverZones(pack.zones, midi, vel);
    if (!zones.length) return false;
    rnd = rnd || (() => 0.5);
    let started = 0;
    for (let i = 0; i < zones.length; i++) {
      if (startVoice(ctx, master, zones[i], midi, t, dur, vel, rnd)) started++;
    }
    return started > 0;
  }

  /* ---------- WebAudio 调度：鼓件（力度选区 + 声像 + 互斥掐断） ----------
     KILL_T：fluidsynth 掐镲把 volEnv 释音改写为 −200 timecents，
     fluid_tc2sec_release(−200) = 2^(−200/1200) 秒；释音段在归一化
     衰减域线性（−1/count 每步）即幅度域 cB 线性，960cB 全程对应
     10^(−4.8) ≈ 静音，按此斜率铺曲线重写增益。
     MIN_NOTE：synth.min-note-length 缺省 10ms，被掐声部不足 10ms
     音龄时延到满 10ms 才起释音（fluid_rvoice_noteoff_LOCAL 语义）。
     掐断只动增益曲线：调制包络不改写，听感由增益主导，留档备案。 */
  const KILL_T = Math.pow(2, -200 / 1200);   // ≈0.8909s
  const MIN_NOTE = 0.010;                    // synth.min-note-length 缺省
  const drumReg = new WeakMap();             // 渲染上下文 → 活动鼓音
  let trigSeq = 0;                           // 触发组号（同组孪生互不掐）

  function killDrumVoice(v, t) {
    v.killed = true;
    const tRel = Math.max(t, v.t0 + MIN_NOTE);
    const g = v.g;
    const peak = g.gain.value;               // 静态增益，尚无自动化事件
    g.gain.cancelScheduledValues(tRel);
    const N = Math.min(1024, Math.max(64, Math.ceil(KILL_T * 500) + 1));
    const arr = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (KILL_T * i) / (N - 1);
      arr[i] = peak * Math.pow(10, (-4.8 * x) / KILL_T);
    }
    arr[N - 1] = 0;                          // 终点直接静音（fluidsynth FINISHED）
    g.gain.setValueCurveAtTime(arr, tRel, KILL_T);
  }

  function scheduleDrum(ctx, master, drum, t, vel, rnd) {
    if (state.status !== 'ready') return false;
    const d = state.manifest.drums[drum];
    if (!d || !d.zones || !d.zones.length) return false;
    const zones = coverZones(d.zones, d.key, vel);
    if (!zones.length) return false;
    rnd = rnd || (() => 0.5);
    const bufs = [];
    for (let i = 0; i < zones.length; i++) {
      const b = audioBufferFor(zones[i].file, ctx);
      if (!b) return false;   // 文件缺失整次回退，此时尚无掐断副作用
      bufs.push(b);
    }
    const reg = drumReg.get(ctx);
    const alive = reg ? reg.filter((v) => v.t1 > t) : [];
    const gid = ++trigSeq;
    // fluidsynth start_voice：异组、同类值的在声部一律掐（同组＝同一次
    // 触发的孪生分区，voice id 相同互不掐）
    for (let i = 0; i < zones.length; i++) {
      const cls = zones[i].excl || 0;
      if (!cls) continue;
      for (let j = 0; j < alive.length; j++) {
        const v = alive[j];
        if (!v.killed && v.cls === cls && v.gid !== gid) killDrumVoice(v, t);
      }
    }
    let started = 0;
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      const buf = bufs[i];
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 1 + (rnd() - 0.5) * 0.03;   // ±1.5%
      const att = z.att == null ? 1 : z.att;
      const peak = (vel / 127) * att * DRUM_K * filterGain(z)
        * (0.95 + rnd() * 0.1);
      const g = ctx.createGain();
      g.gain.value = peak;
      // 鼓件同走滤波级（FluidR3 鼓组带 fc/fq/m2fc）。单次触发不松手，
      // 调制包络只走延迟到延持段，曲线铺满整个采样时长
      const dur = buf.duration / src.playbackRate.value;
      connectFilter(ctx, src, g, z, t, dur, Infinity);
      if (z.pan) {
        const panner = ctx.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, z.pan / 500));
        g.connect(panner);
        panner.connect(master);
      } else {
        g.connect(master);
      }
      src.start(t);
      alive.push({ cls: z.excl || 0, gid, g, t0: t, t1: t + dur, killed: false });
      started++;
    }
    drumReg.set(ctx, alive);
    return started > 0;
  }

  /* ---------- 加载：全有或全无 ----------
     任何一份失败整体置 failed，band.js 全程回退合成，绝不半采样混搭。 */
  function load() {
    if (state.promise) return state.promise;
    state.status = 'loading';
    state.promise = (async () => {
      try {
        if (typeof fetch !== 'function') throw new Error('环境无 fetch');
        const res = await fetch(BASE + 'manifest.json');
        if (!res.ok) throw new Error('manifest HTTP ' + res.status);
        const man = await res.json();
        const files = new Set();
        Object.keys(man.instruments || {}).forEach((k) => {
          (man.instruments[k].zones || []).forEach((z) => files.add(z.file));
        });
        Object.keys(man.drums || {}).forEach((k) => {
          ((man.drums[k] && man.drums[k].zones) || []).forEach((z) => files.add(z.file));
        });
        const list = Array.from(files);
        if (!list.length) throw new Error('manifest 无采样文件');
        let cursor = 0;
        async function worker() {
          while (cursor < list.length) {
            const f = list[cursor++];
            const r = await fetch(BASE + f);
            if (!r.ok) throw new Error(f + ' HTTP ' + r.status);
            state.buffers.set(f, parseWav(await r.arrayBuffer()));
          }
        }
        const n = Math.min(LOAD_CONCURRENCY, list.length);
        await Promise.all(Array.from({ length: n }, () => worker()));
        state.manifest = man;
        state.status = 'ready';
      } catch (err) {
        state.status = 'failed';
        state.error = err;
        state.buffers.clear();
        if (global.console && console.warn) {
          console.warn('采样音源加载失败，回退合成音色：', (err && err.message) || err);
        }
      }
      return state.status;
    })();
    return state.promise;
  }

  /* 就绪承诺：ready/failed 都 resolve，渲染方据此选路径，绝不挂起 */
  function whenReady() {
    if (!state.promise) return load();
    return state.promise;
  }

  const api = {
    whenReady, load,
    ready: () => state.status === 'ready',
    status: () => state.status,
    scheduleVoice, scheduleDrum,
    parseWav, pickZone, coverZones, rateOf, envCurve,
    ct2hz, filterQDb, filterGain, convex, menvAt, connectFilter,
    _internals: { state, BASE, R_CAP, VOICE_K, DRUM_K, KILL_T, MIN_NOTE },
  };
  global.BandSampler = api;

  // 浏览器页面加载即预拉（node/测试环境不自动发起）
  if (typeof document !== 'undefined') whenReady();
})(typeof window !== 'undefined' ? window : globalThis);
