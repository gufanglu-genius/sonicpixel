/* ============================================================
   音智新媒 · 工作台交互层
   所有指标由 SonicEngine 现场计算，页面不含预置样本数据
   ============================================================ */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const E = window.SonicEngine;

  /* ---------- 状态 ---------- */
  const state = {
    originBuffer: null,
    processedBuffer: null,
    profile: null,
    profileProcessed: null,
    profileArrangement: null,
    arrangement: null,
    showingAfter: false,
    eqParams: new Array(10).fill(0),
    /* 用户是否手动拖过 EQ。真值放在 state 而不是扒 DOM 的文字：
       换素材类型、恢复工作区都要靠它决定「处方重算要不要动 EQ」。 */
    eqManual: false,
    audioCtx: null,
    playNodes: [],
    versionTree: [],
    muted: {},      // 轨道静音态（持久，不依赖 DOM class）
    loadGen: 0,     // 素材代数：过期的异步分析/渲染直接丢弃
    renderBusy: false,
    /* 源素材的原始字节 + 出身：存盘时按它去重写入，派生 PCM 一律不存。
       只有导入的文件和合成的示例会有值，见 store.js 的注释。 */
    _srcBytes: null,
    _srcSize: 0,
    _srcKind: 'file',
    /* 素材类型：'ai' = AI 生成音乐，'acoustic' = 真实录音。
       两条处理链不同，所以这是 L2 的输入而不是展示用的标签。
       注意别和 _srcKind 混——那个说的是文件从哪来（导入/示例）。 */
    material: 'ai',
    /* L1 检出、要下陷波的频率（工频哼声/整流纹波）。随体检结果刷新。 */
    notches: [],

    /* —— 第一梯队创新的运行时状态 —— */
    fileBuffer: null,      // 导入时的整曲：结构编辑只在这上面叠加，「还原整曲」的原点
    fileLabel: null,       // 整曲的名字（结构改版标签退回它）
    structPlan: null,      // 结构重排的待应用序列 [{s,e,l}]（秒，相对本次输入）
    structSel: -1,         // 当前选中的段
    structDirty: false,    // 计划动过没有（没动过就不白跑重分析）
    structHistory: [],     // 已应用的结构计划（存盘；恢复时按序从整曲折叠）
    lufs: null,            // {orig, proc} BS.1770 门限后积分实测
    lufsTarget: 'off',     // 导出响度目标（平台合规）
    loudCurve: null,       // {orig, proc} 短时响度曲线（E.loudnessCurve 快照；proc 在导出带目标时为对齐版）
  };

  /* 测试钩子：probe-l2 / probe-arrangement 等探针直接读运行时状态。
     本来就是页面自己的数据，暴露给同源脚本没有额外权限面。 */
  window.__state = state;

  /* 谐波外残余能量比：历史上字段名叫 thd，但语义是残余比不是谐波失真。
     兼容引擎改名（nonharmonicRatio）前后两种数据契约；两者都没有时返回 null。 */
  const residualRatio = (q) => {
    if (!q) return null;
    const v = q.nonharmonicRatio != null ? q.nonharmonicRatio : q.thd;
    return v == null || Number.isNaN(v) ? null : v;
  };
  const coverageOf = (q) => {
    if (!q) return null;
    const v = q.nonharmonicCoverage != null ? q.nonharmonicCoverage : q.thdCoverage;
    return v == null || Number.isNaN(v) ? null : v;
  };

  /* 动态还原给多少量：LRA 越小说明被响度目标压得越平，要张得越开。
     LRA 到 11 dB 就给 0 —— 动态本来就没被压过，张开是画蛇添足。 */
  const expandOf = (q) => {
    const lra = q && q.lra ? q.lra : 0;
    return Math.min(1, Math.max(0, (11 - lra) / 11));
  };

  /* 要下陷波的频率，全由 L1 实测决定，与素材类型无关。
     谐波要不要跟着补，按 humKind 分：整流纹波常只有 2×、基频已被前端滤掉，
     该补的是 1/2 倍频；工频与窄带峰才补 2×、3×。
     900Hz 封顶：再往上就不叫低频哼声了，砍下去伤的是乐器。 */
  const notchesOf = (q) => {
    if (!q || !(q.humScore > 0.2) || !(q.humFreq > 0)) return [];
    const f = q.humFreq;
    const out = [f];
    const add = (x) => { if (x >= 45 && x < 900) out.push(x); };
    if (q.humKind === 'ripple') { add(f / 2); add(f * 2); }
    else { add(f * 2); add(f * 3); }
    return out;
  };

  /* ---------- 画布配色（与 CSS token 对齐） ---------- */
  const C = {
    terracotta: '#C66B3D', clay: '#B08B6E', moss: '#606C38',
    ochre: '#C08E3A', sage: '#8B9D83', oat: '#D4B895',
    ink: '#2E2620', inkSoft: '#5A4E42', inkFaint: '#8A7B6B',
  };
  const SEG_COLORS = [C.moss, C.terracotta, C.ochre, C.clay, C.sage, C.inkSoft];
  const TRACK_COLORS = {
    lead: C.terracotta, harm: C.clay, bass: C.moss,
    drums: C.ochre, pad: C.sage,
  };

  function getCtx() {
    if (!state.audioCtx) {
      state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return state.audioCtx;
  }

  const fmtTime = (s) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  };

  /* ============================================================
     滚动显现 + 宫商角徵羽导航轨
     ============================================================ */
  function initScroll() {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -6% 0px' });
    $$('.reveal').forEach((el) => io.observe(el));

    const sections = $$('[data-stage]');
    const railItems = $$('.rail-item');
    let raf = 0;
    const spyTick = () => {
      raf = 0;
      if (!sections.length || !railItems.length) return;
      // 以视口 42% 处作为“当前段”的判定线，直接算滚动位置，
      // 不依赖 IntersectionObserver 的竞态
      const line = window.innerHeight * 0.42;
      let active = 0;
      sections.forEach((s, i) => {
        const r = s.getBoundingClientRect();
        if (r.top <= line) active = i;
      });
      railItems.forEach((b, k) => {
        b.classList.toggle('is-active', k === active);
        b.classList.toggle('is-done', k < active);
      });
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(spyTick);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    spyTick();

    const jump = (btn) => {
      const t = document.getElementById(btn.dataset.target);
      if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    railItems.forEach((btn) => {
      btn.addEventListener('click', () => jump(btn));
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(btn); }
      });
    });

    const heroImg = $('#heroImg');
    if (heroImg) {
      if (heroImg.complete) heroImg.classList.add('is-ready');
      else heroImg.addEventListener('load', () => heroImg.classList.add('is-ready'));
    }
  }

  /* ============================================================
     Canvas 绘图
     ============================================================ */
  function setupCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    // 可视宽度 = 父容器内容区（clientWidth 含内边距，要减掉；
    // canvas 的 width:100% 是按内容区算的）
    const pw = cv.parentElement;
    let w = pw ? pw.clientWidth : 0;
    if (pw) {
      const pcs = getComputedStyle(pw);
      w -= (parseFloat(pcs.paddingLeft) || 0) + (parseFloat(pcs.paddingRight) || 0);
    }
    w = Math.max(w, 280);
    // 设计高度只解析一次并缓存：cv.height 会反射回 height content attribute，
    // 若再用 getAttribute('height') 回读，HiDPI 下每次重绘高度都会 ×dpr 膨胀
    if (cv.dataset.cssH == null) {
      cv.dataset.cssH = String(Number(cv.getAttribute('height')) || 200);
    }
    const h = Number(cv.dataset.cssH) || 200;
    cv.width = Math.floor(w * dpr);
    cv.height = Math.floor(h * dpr);
    cv.style.width = '100%';
    cv.style.height = h + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function drawSpectrum(cv, spectrum, sr) {
    const { ctx, w, h } = setupCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    if (!spectrum || !spectrum.length) return;

    const pad = { t: 16, r: 14, b: 30, l: 42 };
    const gw = w - pad.l - pad.r;
    const gh = h - pad.t - pad.b;

    ctx.strokeStyle = 'rgba(46,38,32,.1)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (gh * i) / 4;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + gw, y); ctx.stroke();
    }
    ctx.fillStyle = C.inkFaint;
    ctx.font = '11px Epilogue, "Noto Sans SC", sans-serif';
    ctx.textAlign = 'right';
    ['0', '-20', '-40', '-60'].forEach((t, i) => {
      ctx.fillText(t, pad.l - 8, pad.t + (gh * i) / 4 + 4);
    });

    const fMin = 40, fMax = 16000;
    const binHz = sr / (spectrum.length * 2);
    const xOf = (f) => pad.l + (Math.log(f / fMin) / Math.log(fMax / fMin)) * gw;

    // 参考竖线
    ctx.strokeStyle = 'rgba(96,108,56,.28)';
    ctx.fillStyle = C.moss;
    ctx.textAlign = 'center';
    [110, 220, 440, 880, 1760, 3520].forEach((f) => {
      const x = xOf(f);
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + gh); ctx.stroke();
      ctx.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x, h - 9);
    });

    // quality.spectrum 是未归一化的平均功率（engine qualityMetrics），
    // 以峰值 bin 为参考换算成功率相对 dB（功率口径用 10*log10），范围 ≤ 0，
    // 与纵轴 0→-80 的 y 映射和 '0/-20/-40/-60' 刻度自洽——刻度数字是真实算出来的。
    let pRef = 1e-20;
    for (let i = 1; i < spectrum.length; i++) {
      if (spectrum[i] > pRef) pRef = spectrum[i];
    }
    if (pRef <= 1e-19) return; // 全零/静音频谱，无可画内容
    const pts = [];
    for (let i = 1; i < spectrum.length; i++) {
      const f = i * binHz;
      if (f < fMin || f > fMax) continue;
      const db = 10 * Math.log10(Math.max(spectrum[i], 1e-20) / pRef);
      const y = pad.t + gh * (1 - Math.max(0, Math.min(1, (db + 80) / 80)));
      pts.push({ x: xOf(f), y });
    }
    if (!pts.length) return;

    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + gh);
    grad.addColorStop(0, 'rgba(198,107,61,.32)');
    grad.addColorStop(1, 'rgba(198,107,61,.02)');
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pad.t + gh);
    pts.forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.lineTo(pts[pts.length - 1].x, pad.t + gh);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.strokeStyle = C.terracotta;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function drawStructure(cv, structure, duration) {
    const { ctx, w, h } = setupCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    if (!structure || !structure.length) return;
    const pad = { t: 20, r: 14, b: 32, l: 42 };
    const gw = w - pad.l - pad.r;
    const gh = h - pad.t - pad.b;

    structure.forEach((s, i) => {
      const x0 = pad.l + (s.start / duration) * gw;
      const x1 = pad.l + (s.end / duration) * gw;
      const bw = Math.max(10, x1 - x0 - 4);
      const bh = Math.max(12, s.energy * gh);
      const y = pad.t + gh - bh;
      const col = SEG_COLORS[i % SEG_COLORS.length];

      ctx.fillStyle = col + '2E';
      ctx.fillRect(x0 + 2, y, bw, bh);
      ctx.fillStyle = col;
      ctx.fillRect(x0 + 2, y, bw, 3);

      if (i > 0) {
        ctx.strokeStyle = 'rgba(46,38,32,.15)';
        ctx.beginPath();
        ctx.moveTo(x0, pad.t); ctx.lineTo(x0, pad.t + gh); ctx.stroke();
      }

      // 段落名
      if (bw > 34) {
        ctx.fillStyle = C.inkSoft;
        ctx.font = '11px Epilogue, "Noto Sans SC", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(s.section, x0 + 7, pad.t + 13);
      }
    });

    ctx.fillStyle = C.inkFaint;
    ctx.font = '11px Epilogue, "Noto Sans SC", sans-serif';
    ctx.textAlign = 'center';
    for (let i = 0; i <= 5; i++) {
      ctx.fillText(fmtTime((duration * i) / 5), pad.l + (gw * i) / 5, h - 8);
    }
  }

  function drawEqCurve(cv, gains) {
    const curve = gains && gains.length ? gains : new Array(10).fill(0);
    const { ctx, w, h } = setupCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    const pad = { t: 18, r: 14, b: 18, l: 38 };
    const gw = w - pad.l - pad.r;
    const gh = h - pad.t - pad.b;

    ctx.strokeStyle = 'rgba(46,38,32,.14)';
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t + gh / 2);
    ctx.lineTo(pad.l + gw, pad.t + gh / 2);
    ctx.stroke();

    ctx.fillStyle = C.inkFaint;
    ctx.font = '10px Epilogue, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('+12', pad.l - 6, pad.t + 9);
    ctx.fillText('0', pad.l - 6, pad.t + gh / 2 + 3);
    ctx.fillText('-12', pad.l - 6, pad.t + gh - 3);

    const pts = curve.map((g, i) => ({
      x: pad.l + (gw * i) / (curve.length - 1),
      y: pad.t + gh / 2 - (Math.max(-1, Math.min(1, g)) / 1) * (gh / 2) * 0.92,
    }));

    // 面积
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + gh);
    grad.addColorStop(0, 'rgba(96,108,56,.18)');
    grad.addColorStop(1, 'rgba(96,108,56,.02)');
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pad.t + gh / 2);
    pts.forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.lineTo(pts[pts.length - 1].x, pad.t + gh / 2);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.strokeStyle = C.moss;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    pts.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = '#E8DCC7';
      ctx.fill();
      ctx.strokeStyle = C.moss;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }

  function drawWave(cv, buffer, color) {
    const { ctx, w, h } = setupCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    if (!buffer) return;
    const data = buffer.getChannelData(0);
    const pad = { t: 14, r: 10, b: 14, l: 10 };
    const gw = w - pad.l - pad.r;
    const gh = h - pad.t - pad.b;
    const mid = pad.t + gh / 2;

    ctx.strokeStyle = 'rgba(46,38,32,.12)';
    ctx.beginPath(); ctx.moveTo(pad.l, mid); ctx.lineTo(pad.l + gw, mid); ctx.stroke();

    const step = Math.max(1, Math.floor(data.length / gw));
    ctx.beginPath();
    for (let x = 0; x < gw; x++) {
      let min = 1, max = -1;
      const start = x * step;
      for (let i = 0; i < step; i++) {
        const v = data[start + i] || 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      ctx.moveTo(pad.l + x, mid + min * (gh / 2));
      ctx.lineTo(pad.l + x, mid + max * (gh / 2));
    }
    ctx.strokeStyle = color || C.terracotta;
    ctx.lineWidth = 1.15;
    ctx.stroke();
  }

  function drawPiano(cv, events) {
    const { ctx, w, h } = setupCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    if (!events || !events.length) return;

    const pad = { t: 14, r: 12, b: 24, l: 42 };
    const gw = w - pad.l - pad.r;
    const gh = h - pad.t - pad.b;

    const notes = events.map((e) => e.note);
    const lo = Math.min(...notes) - 2;
    const hi = Math.max(...notes) + 2;
    const span = Math.max(1, hi - lo);
    const tMax = Math.max(...events.map((e) => e.t + e.dur)) || 1;

    ctx.strokeStyle = 'rgba(46,38,32,.08)';
    for (let i = 0; i <= 8; i++) {
      const y = pad.t + (gh * i) / 8;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + gw, y); ctx.stroke();
    }

    events.forEach((e) => {
      const x = pad.l + (e.t / tMax) * gw;
      const bw = Math.max(4, (e.dur / tMax) * gw * 0.8);
      const y = pad.t + gh * (1 - (e.note - lo) / span);
      ctx.fillStyle = (TRACK_COLORS[e.track] || C.clay) + 'CC';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y - 5, bw, 10, 3);
      else ctx.rect(x, y - 5, bw, 10);
      ctx.fill();
    });

    ctx.fillStyle = C.inkFaint;
    ctx.font = '10px Epilogue, sans-serif';
    ctx.textAlign = 'right';
    [lo, Math.round((lo + hi) / 2), hi].forEach((n) => {
      ctx.fillText(String(n), pad.l - 8,
        pad.t + gh * (1 - (n - lo) / span) + 3);
    });
    ctx.textAlign = 'left';
    ctx.fillText('0s', pad.l, h - 7);
    ctx.textAlign = 'right';
    ctx.fillText(fmtTime(tMax), pad.l + gw, h - 7);
  }

  /* ============================================================
     调式盘 / 色度 / 指标
     ============================================================ */
  function renderModeDial(profile) {
    const id = profile.identity;

    $('#modeGlyph').textContent = id.modeGlyph || '—';
    // 中心同时报两套体系：中国传统五声（羽调式）+ 西方大/小调（小调），
    // 用户要求「测调式不能只报宫商角徵羽」，盘面就是第一落点。
    $('#modeName').textContent =
      (id.modeName || '待检测') + (id.tonalityName ? ` · ${id.tonalityName}` : '');

    const ring = $('#ringFg');
    if (ring) {
      const circ = 2 * Math.PI * 104;
      ring.style.strokeDasharray = String(circ);
      ring.style.strokeDashoffset = String(circ * (1 - (id.modeConfidence || 0)));
    }

    // chips
    const chips = $('#modeChips');
    chips.innerHTML = '';
    [
      ['主音', id.key || '—'],
      ['调式', id.modeName || '—'],
      ['调性', id.westernKey || id.tonalityName || '—'],
      ['BPM', id.bpm ? id.bpm.toFixed(1) : '—'],
      ['拍号', id.meter || '—'],
      ['置信度', id.modeConfidence != null ? (id.modeConfidence * 100).toFixed(0) + '%' : '—'],
      ['五声符合', id.pentaFit != null ? (id.pentaFit * 100).toFixed(0) + '%' : '—'],
    ].forEach(([k, v], i) => {
      const el = document.createElement('span');
      el.className = 'chip' + (i < 3 ? ' is-active' : '');
      el.innerHTML = `${k}　${v}`;
      chips.appendChild(el);
    });

    // 色度行：五声集合恒以宫音为参照（商/角/徵/羽是同一集合的旋转），
    // 高亮应对宫音集合，而不是对主音平移固定集合；主音 '—'（静音/无法定调）时不高亮
    const chroma = profile.raw.chroma;
    const max = Math.max(...chroma, 0.01);
    const STEPS = [0, 2, 4, 7, 9]; // 宫集合（与 engine.js PENTA_STEPS 一致）
    const MODE_DEG = { gong: 0, shang: 1, jue: 2, zhi: 3, yu: 4 };
    const rootIdx = E.PC_NAMES.indexOf(id.key); // '—'/未定调 → -1，不能用 ||'C' 兜底
    let gongIdx = id.gongIndex; // 引擎透出宫音参照时直接用
    if (gongIdx == null && rootIdx >= 0) {
      // 回退：宫音 = 主音回退到集合第 deg 级
      gongIdx = ((rootIdx - STEPS[MODE_DEG[id.mode] ?? 0]) % 12 + 12) % 12;
    }
    const bars = $('#chromaBars');
    bars.innerHTML = '';
    chroma.forEach((v, i) => {
      const row = document.createElement('div');
      const inScale = gongIdx != null && rootIdx >= 0 &&
        STEPS.includes(((i - gongIdx) % 12 + 12) % 12);
      row.className = 'chroma-row' + (inScale ? ' is-scale' : '');
      row.innerHTML =
        `<span class="chroma-name">${E.PC_NAMES[i]}</span>` +
        `<span class="chroma-track"><i class="chroma-fill" style="width:${Math.max(3, (v / max) * 100)}%"></i></span>` +
        `<span class="chroma-val">${(v * 100).toFixed(1)}</span>`;
      bars.appendChild(row);
    });
  }

  function renderMetrics(profile) {
    const q = profile.quality;
    const id = profile.identity;
    const set = (sel, text, unit) => {
      const el = $(sel);
      el.classList.remove('is-empty');
      el.innerHTML = text + (unit ? `<span class="unit">${unit}</span>` : '');
    };
    set('#mBpm', id.bpm ? id.bpm.toFixed(1) : '—');
    set('#mMeter', id.meter || '—');
    // 速度跟体检走。调式走 buildModeSelect、拍号走 syncMeterBadge，
    // 唯独速度滑块一直停在 HTML 默认 92：原曲 139.9 BPM 会被静默改成 92 渲染，
    // 回流又把「按 92 BPM 生成」打出来，和体检的 139.9 当面对撞却没人解释。
    // 用户点了「渲染乐段」，实际拿到了一首慢了 49% 的曲子。
    if (id.bpm) {
      const range = $('#bpmRange');
      if (range) {
        const lo = Number(range.min), hi = Number(range.max);
        const v = Math.min(hi, Math.max(lo, Math.round(id.bpm * 10) / 10));
        range.value = String(v);
        const out = $('#bpmOut');
        if (out) out.textContent = `${v} BPM`;
      }
    }
    set('#mDur', profile.meta.duration ? profile.meta.duration.toFixed(1) : '—', 's');
    // 采样率要报原文件的：decodeAudioData 会把素材重采到上下文采样率，
    // 直接用 buffer.sampleRate 等于把 48k 的文件报成 44.1k，而副标写的是
    // 「原始采样率」。读不出原生值（ogg/m4a 等）就退回分析采样率并改副标。
    const sniffed = state._srcBytes ? E.sniffSampleRate(state._srcBytes) : 0;
    const srcRate = sniffed || profile.meta.sampleRate || 0;
    set('#mSr', srcRate ? (srcRate / 1000).toFixed(1) : '—', 'kHz');
    const srBox = $('#mSr') ? $('#mSr').closest('.metric') : null;
    const srSub = srBox ? srBox.querySelector('.metric-sub') : null;
    if (srSub) srSub.textContent = sniffed ? '原始采样率' : '解码采样率';
    const resid = residualRatio(q);
    set('#mThd', resid != null ? (resid * 100).toFixed(1) : '—', '%');
    set('#mLra', q.lra != null ? q.lra.toFixed(1) : '—', 'dB');
    set('#mCent', profile.timbre.centroid ? Math.round(profile.timbre.centroid) : '—', 'Hz');
    set('#mCrest', q.crest != null ? q.crest.toFixed(1) : '—', 'dB');
    // 低频缺陷分 = max(谐波间涂抹, 工频哼声)。副标说清是谁在贡献，
    // 不能让用户看着一个综合分猜不出成因。
    set('#mMud', q.mudScore != null ? (q.mudScore * 100).toFixed(1) : '—', '%');
    const mudSub = $('#mMudSub');
    if (mudSub) {
      const smear = q.mudSmear != null ? q.mudSmear : 0;
      const hum = q.humScore != null ? q.humScore : 0;
      // 「干净」只在数字真小的时候说。24% 还写「低频干净」是自相矛盾，
      // 曾经显示 mud 29% + 副标「低频干净」就是这么来的。
      if (q.mudScore < 0.08) {
        mudSub.textContent = '低频干净 · 能量压在泛音列上';
      } else if (hum >= smear && hum > 0.15) {
        // 分诊由引擎给出（humKind），UI 只显示不猜：整流纹波是 100/120Hz
        // 的二次谐波，和 50/60Hz 的工频哼声、更低的窄带隆隆声是三码事。
        const kind = q.humKind === 'ripple' ? '整流纹波'
          : q.humKind === 'mains' ? '工频' : '窄带峰';
        mudSub.textContent = `${kind} ${q.humFreq || '—'}Hz · 涂抹 ${(smear * 100).toFixed(1)}%`;
      } else {
        mudSub.textContent =
          `谐波间涂抹 ${(smear * 100).toFixed(1)}%` +
          (hum > 0.15 ? ` · 窄带峰 ${q.humFreq || '—'}Hz` : ' · 未检出窄带峰');
      }
    }
    // 整体响度（BS.1770 门限后）：测不出就诚实留空，不编数字
    const luEl = $('#mLufs');
    if (luEl) {
      const lu = state.lufs && state.lufs.orig;
      if (lu && lu.lufs != null) {
        set('#mLufs', lu.lufs.toFixed(1), 'LUFS');
      } else {
        luEl.textContent = '—';
        luEl.classList.add('is-empty');
      }
    }
  }

  function renderStructureLegend(structure) {
    const wrap = $('#structureLegend');
    wrap.innerHTML = '';
    structure.forEach((s, i) => {
      const el = document.createElement('span');
      el.className = 'legend-item';
      el.innerHTML =
        `<i class="legend-swatch" style="background:${SEG_COLORS[i % SEG_COLORS.length]}"></i>` +
        `${s.section} · ${fmtTime(s.start)}–${fmtTime(s.end)}`;
      wrap.appendChild(el);
    });
  }

  /* ============================================================
     第一梯队创新：证据链 / 响度合规 / 盲听 / 结构重排 / 互转 / 有据 AI
     ============================================================ */

  /* ---------- ① L1 证据链 ----------
     只画体检当时真实留下的量（包络、候选分、门限、色度、门限后响度）。
     证据里没有的宁可写「未留下」也不现算——现算的换了条件就变，
     那不是「当时的证据」。老存盘没有 evidence 字段的，从 raw 确定性重建
     （同输入同结果的那几项），重建不了的诚实留 null。 */
  const EV_TABS = [
    { id: 'bpm', label: 'BPM' },
    { id: 'meter', label: '拍号' },
    { id: 'mode', label: '调式' },
    { id: 'tonality', label: '大小调' },
    { id: 'lufs', label: '响度' },
  ];
  let evTab = 'bpm';

  const METER_REASONS = {
    input: '输入太短或没有 BPM，拍号无从测起',
    beatlag: '拍长超出包络可用范围',
    'too-few-beats': '可用拍数不足 10',
    'no-valid-window': '没有可用的相位窗',
    'flat-envelope': '起音包络没有起伏',
    cv: '跨时段稳定性没过门',
    r2: '小节周期解释力不够',
    gap: '与对手周期分不开',
    shape: '强弱形状相关太低',
  };

  function ensureEvidence(profile) {
    if (!profile || profile.evidence) return;
    const I = E._internals;
    const raw = profile.raw || {};
    const ev = { bpm: null, meter: null, mode: null, tonality: null };
    if (I && raw.chroma) {
      try {
        const md = I.detectMode(raw.chroma);
        if (md && md.root) {
          ev.mode = {
            gongRoot: md.gongRoot || null, root: md.root, confidence: md.confidence,
            pentaFit: md.pentaFit, nEff: md.nEff != null ? md.nEff : null,
            relMargin: md.relMargin != null ? md.relMargin : null,
            setCert: md.setCert != null ? md.setCert : null,
            degScores: md.degScores || [], ranked: md.ranked || [],
          };
          if (md.root !== '—' && md.rootIndex != null) {
            const ton = I.detectTonality(raw.chroma, md.rootIndex);
            if (ton && ton.tonality) ev.tonality = ton;
          }
        }
      } catch (err) { console.info('[ev] 调式证据重建失败', err); }
    }
    if (I && raw.envelope && profile.identity && profile.identity.bpm) {
      try {
        const m = I.estimateMeter(raw.envelope, raw.envFps || 0, profile.identity.bpm);
        if (m) {
          ev.meter = {
            meter: m.meter, confidence: m.confidence,
            scores: m.scores || [], reason: m.reason || null, info: m.info || null,
          };
        }
      } catch (err) { console.info('[ev] 拍号证据重建失败', err); }
    }
    profile.evidence = ev;
  }

  function evLine(cls, text, path) {
    const div = document.createElement('div');
    div.className = 'ev-line is-' + cls;
    const b = document.createElement('b');
    b.textContent = text;
    div.appendChild(b);
    if (path) {
      const span = document.createElement('span');
      span.className = 'ev-path';
      span.textContent = path;
      div.appendChild(span);
    }
    return div;
  }

  function renderEvLines() {
    const box = $('#evLines');
    const note = $('#evNote');
    if (!box) return;
    box.innerHTML = '';
    const p = state.profile;
    if (!p) {
      box.appendChild(evLine('neutral', '先完成体检，这里会展示每个数字的原始依据', null));
      if (note) note.textContent = '';
      return;
    }
    const id = p.identity;
    const ev = p.evidence || {};
    const add = (cls, text, path) => box.appendChild(evLine(cls, text, path));

    if (evTab === 'bpm') {
      if (ev.bpm && ev.bpm.peaks && ev.bpm.peaks.length) {
        add('ok',
          `选定 ${id.bpm ? id.bpm.toFixed(1) : '—'} BPM · 峰高占优 ${(ev.bpm.dominance || 0).toFixed(3)}`,
          'L1.bpm ← evidence.bpm.peaks');
        add('neutral',
          `IOI 一致性 ${(ev.bpm.ioiScore || 0).toFixed(3)} · 节奏族 ${(ev.bpm.famScore || 0).toFixed(3)} · ` +
          `密度 ${(ev.bpm.densScore || 0).toFixed(3)} · 起音点 ${ev.bpm.onsetCount} 个`,
          'evidence.bpm.*');
        const top = ev.bpm.peaks.slice(0, 4)
          .map((x) => `${x.bpm}（峰高 ${x.v.toFixed(3)}）`).join('、');
        add('neutral', `候选前四：${top}`, 'evidence.bpm.peaks[0..3]');
        if (ev.bpm.tau != null) {
          add('neutral', `自相关主峰 τ = ${ev.bpm.tau} 帧 @ ${ev.bpm.envFps} fps`, 'evidence.bpm.tau');
        }
      } else {
        add('bad', '本次体检未留下 BPM 候选峰', 'evidence.bpm = null');
        if (id.bpm) add('neutral', `结果仍有 ${id.bpm} BPM（仅结果，无候选证据可查）`, 'L1.bpm');
        if (note) note.textContent = '无效 BPM 或旧版存盘不带候选峰；重新体检一次即可补齐。';
      }
      if (note && ev.bpm) note.textContent = '绿线为起音包络，竖线按选定 BPM 每拍落一格；下方为 40–240 BPM 候选峰，深色是最终选定。';
    } else if (evTab === 'meter') {
      const m = ev.meter;
      if (m) {
        if (m.meter) {
          const info = m.info || {};
          add('ok', `判定 ${m.meter} · 置信 ${m.confidence}`, 'L1.meter ← evidence.meter');
          add('neutral',
            `实测 r²=${info.r2max != null ? info.r2max : '—'} · cv=${info.cvMax != null ? info.cvMax : '—'} · ` +
            `与对手差 ${info.gap != null ? info.gap : '—'} · 形状 r=${info.r != null ? info.r : '—'}`,
            'evidence.meter.info');
          const g = info.gates || {};
          add('neutral',
            `门位：cv≥${g.cv} r²≥${g.r2} 差距≥${g.gap} 形状 r≥${g.shape} —— 四道全过`,
            'evidence.meter.info.gates');
          if (info.rival) add('neutral', `落选对手：${info.rival}（倍数/约数关系不计为对手）`, 'evidence.meter.info.rival');
        } else {
          const why = METER_REASONS[m.reason] || m.reason || '未知原因';
          add('bad', `未定 —— ${why}`, 'L1.meter = null（如实留空）');
          if (m.info) {
            const info = m.info;
            add('neutral',
              `实测 r²=${info.r2max != null ? info.r2max : '—'} · cv=${info.cvMax != null ? info.cvMax : '—'}` +
              (info.gate != null ? ` · 本次门位 ${info.gate}` : ''),
              'evidence.meter.info');
          }
          if (note) note.textContent = '未定不是故障：没有过门的强弱周期时，报一个拍号才是编数字。';
        }
        if (m.scores && m.scores.length) {
          const rows = m.scores.slice(0, 4)
            .map((s) => `${s.meter} r²=${s.r2}`).join('、');
          add('neutral', `候选评分：${rows}`, 'evidence.meter.scores');
        }
      } else {
        add('neutral', '旧版存盘未留拍号证据；重新体检可补齐', 'evidence.meter = null');
      }
      if (note && m && m.meter) note.textContent = '条形为各候选拍号的 r²（解释力），竖线为 0.24 门位；cv 是跨时段稳定性。';
    } else if (evTab === 'mode') {
      const md = ev.mode;
      if (md) {
        add('ok',
          `${md.root} ${id.modeName} · 置信 ${md.confidence} · 五声符合 ${Math.round((md.pentaFit || 0) * 100)}%`,
          'L1.mode ← evidence.mode');
        add('neutral',
          `有效音级 ${md.nEff != null ? md.nEff : '—'} · 领先幅度 ${md.relMargin != null ? md.relMargin : '—'} · ` +
          `集合确定度 ${md.setCert != null ? md.setCert : '—'}`,
          'evidence.mode.*');
        if (md.gongRoot) add('neutral', `宫音参照 ${md.gongRoot} · 主音 ${md.root}`, 'evidence.mode.gongRoot/root');
        if (md.degScores && md.degScores.length) {
          const rows = md.degScores
            .slice().sort((a, b) => b.weight - a.weight).slice(0, 5)
            .map((d) => `${d.pc} ${d.weight}`).join('、');
          add('neutral', `级位中心度前五：${rows}`, 'evidence.mode.degScores');
        }
        if (note) note.textContent = '深色柱为宫音五声集合内的音级，浅色为集合外；柱高是 12 半音色度权重。';
      } else {
        add('neutral', '旧版存盘未留调式证据；重新体检可补齐', 'evidence.mode = null');
      }
    } else if (evTab === 'tonality') {
      const t = ev.tonality;
      if (t && t.tonality) {
        add('ok', `${p.identity.westernKey || t.tonality} · 置信 ${p.identity.tonalityConfidence}`, 'L1.tonality ← evidence.tonality');
        add('neutral',
          `大调轮廓 ${t.majScore != null ? t.majScore : '—'} · 小调轮廓 ${t.minScore != null ? t.minScore : '—'} · ` +
          `差值 ${t.margin != null ? t.margin : '—'}`,
          'evidence.tonality.*');
        if (note) note.textContent = '标尺 −1 到 1：两把尺子是 Krumhansl 大/小调轮廓相关，差值定胜负。';
      } else {
        add('bad', '未标大/小调 —— 主音未定或证据不足', 'L1.tonality = null（不编调性）');
        if (note) note.textContent = '定不出主音时不标大/小调，防止兜底分支假装 C 大调。';
      }
    } else if (evTab === 'lufs') {
      const lu = state.lufs || {};
      if (lu.orig && lu.orig.lufs != null) {
        add('ok',
          `原曲 ${lu.orig.lufs.toFixed(1)} LUFS · 峰值 ${lu.orig.peakDb.toFixed(1)} dBFS`,
          'L1.lufs（BS.1770 门限后积分）');
        add('neutral',
          `${lu.orig.blocks} 个 400ms 块 · 绝对门 −70 LU · 相对门 ${lu.orig.gate} LU`,
          'measureLoudness 门限链');
        if (lu.proc && lu.proc.lufs != null) {
          add('neutral', `精修后 ${lu.proc.lufs.toFixed(1)} LUFS · 峰值 ${lu.proc.peakDb.toFixed(1)} dBFS`, 'L2.lufs');
        }
        const t = lufsTargetOf();
        if (t.lufs != null) add('neutral', `导出目标 ${t.lufs} LUFS（${t.label}）`, '导出响度目标');
        if (note) note.textContent = '标尺上为实测位置；导出时按所选平台目标做常数增益，峰值 −1 dBFS 顶线会如实上报。';
      } else {
        add('neutral', '尚未测得响度（导入体检后自动测）', 'L1.lufs = null');
        if (note) note.textContent = '';
      }
    }
  }

  function drawEvidence() {
    const cv = $('#chartEvidence');
    if (!cv) return;
    const p = state.profile;
    if (!p) {
      const { ctx, w, h } = setupCanvas(cv);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = C.inkFaint;
      ctx.font = '12px Epilogue, "Noto Sans SC", sans-serif';
      ctx.fillText('体检完成后展示证据图', 14, 24);
      return;
    }
    if (evTab === 'bpm') drawEvBpm(cv, p);
    else if (evTab === 'meter') drawEvMeter(cv, p);
    else if (evTab === 'mode') drawEvMode(cv, p);
    else if (evTab === 'tonality') drawEvTonality(cv, p);
    else drawEvLufs(cv);
  }

  function drawEvBpm(cv, p) {
    const { ctx, w, h } = setupCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px Epilogue, "Noto Sans SC", sans-serif';
    const env = p.raw && p.raw.envelope;
    const fps = (p.raw && p.raw.envFps) || 0;
    const evB = p.evidence && p.evidence.bpm;
    const pad = { t: 14, r: 14, b: 26, l: 44 };
    const gw = w - pad.l - pad.r;
    const gh = h - pad.t - pad.b;
    const topH = Math.round(gh * 0.56);
    const botTop = pad.t + topH + 20;
    const botH = h - pad.b - botTop;

    // 上：起音包络 + 拍网格
    ctx.strokeStyle = 'rgba(46,38,32,.08)';
    for (let i = 0; i <= 2; i++) {
      const y = pad.t + (topH * i) / 2;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + gw, y); ctx.stroke();
    }
    if (env && env.length > 1) {
      const max = Math.max.apply(null, env.concat([1e-9]));
      ctx.beginPath();
      for (let i = 0; i < env.length; i++) {
        const x = pad.l + (i / (env.length - 1)) * gw;
        const y = pad.t + topH - (env[i] / max) * (topH - 4) - 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = C.inkSoft;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      if (p.identity.bpm && fps) {
        const beatFrames = (60 / p.identity.bpm) * fps;
        ctx.strokeStyle = 'rgba(96,108,56,.45)';
        ctx.lineWidth = 1;
        for (let f = 0; f < env.length; f += beatFrames) {
          const x = pad.l + (f / env.length) * gw;
          ctx.beginPath();
          ctx.moveTo(x, pad.t);
          ctx.lineTo(x, pad.t + topH);
          ctx.stroke();
        }
      }
      ctx.fillStyle = C.inkFaint;
      ctx.fillText('起音包络 · 绿线为每拍位置', pad.l, pad.t + 10);
      if (fps) {
        const durS = env.length / fps;
        ctx.fillText('0s', pad.l, pad.t + topH + 14);
        ctx.fillText(durS.toFixed(0) + 's', pad.l + gw - 24, pad.t + topH + 14);
      }
    } else {
      ctx.fillStyle = C.inkFaint;
      ctx.fillText('本次体检未留下起音包络', pad.l, pad.t + 16);
    }

    // 下：候选峰（40–240 BPM）
    ctx.fillStyle = C.inkFaint;
    ctx.fillText('候选峰 · 40–240 BPM', pad.l, botTop - 6);
    const baseY = botTop + botH - 16;
    if (evB && evB.peaks && evB.peaks.length) {
      const xOf = (bpm) => pad.l + ((Math.min(240, Math.max(40, bpm)) - 40) / 200) * gw;
      const maxV = Math.max.apply(null, evB.peaks.map((x) => x.v).concat([1e-9]));
      evB.peaks.forEach((pk) => {
        const x = xOf(pk.bpm);
        const bh = Math.max(2, (pk.v / maxV) * (botH - 20));
        const isSel = p.identity.bpm && Math.abs(pk.bpm - p.identity.bpm) < 0.6;
        ctx.fillStyle = isSel ? C.terracotta : C.clay;
        ctx.fillRect(x - 4, baseY - bh, 8, bh);
      });
      if (p.identity.bpm) {
        const x = xOf(p.identity.bpm);
        ctx.strokeStyle = C.terracotta;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x, botTop);
        ctx.lineTo(x, baseY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = C.terracotta;
        ctx.fillText(`${p.identity.bpm} BPM`, Math.min(x + 5, w - 70), botTop + 10);
      }
      ctx.strokeStyle = 'rgba(46,38,32,.2)';
      ctx.beginPath();
      ctx.moveTo(pad.l, baseY);
      ctx.lineTo(pad.l + gw, baseY);
      ctx.stroke();
      ctx.fillStyle = C.inkFaint;
      [40, 120, 240].forEach((b) => {
        const x = xOf(b);
        ctx.fillText(String(b), x - 8, baseY + 14);
      });
    } else {
      ctx.fillStyle = C.inkFaint;
      ctx.fillText('未留下候选峰（无效 BPM 或旧版存盘）', pad.l, botTop + 16);
    }
  }

  function drawEvMeter(cv, p) {
    const { ctx, w, h } = setupCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px Epilogue, "Noto Sans SC", sans-serif';
    const evM = p.evidence && p.evidence.meter;
    const scores = (evM && evM.scores && evM.scores.length)
      ? evM.scores
      : ((p.raw && p.raw.meterScores) || []);
    if (!scores.length) {
      ctx.fillStyle = C.inkFaint;
      ctx.fillText('未留下候选评分', 14, 24);
      return;
    }
    const pad = { t: 18, r: 76, b: 30, l: 52 };
    const gw = w - pad.l - pad.r;
    const rows = scores.slice(0, 8);
    const rowH = Math.min(26, (h - pad.t - pad.b) / rows.length);
    const maxR2 = Math.max(0.35, Math.max.apply(null, rows.map((s) => s.r2).concat([0.35])));
    // 门位竖线
    const gateX = pad.l + (0.24 / maxR2) * gw;
    ctx.strokeStyle = 'rgba(198,107,61,.65)';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(gateX, pad.t - 6);
    ctx.lineTo(gateX, pad.t + rowH * rows.length + 4);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.terracotta;
    ctx.fillText('r² 门 0.24', Math.min(gateX + 4, w - 70), pad.t - 8);

    rows.forEach((s, i) => {
      const y = pad.t + i * rowH;
      const chosen = evM && evM.meter === s.meter;
      ctx.fillStyle = chosen ? C.ink : C.inkSoft;
      ctx.fillText(s.meter, pad.l - 36, y + rowH * 0.68);
      const bw = Math.max(2, (s.r2 / maxR2) * gw);
      ctx.fillStyle = chosen ? C.terracotta : C.clay;
      ctx.fillRect(pad.l, y + 4, bw, rowH - 10);
      ctx.fillStyle = C.inkSoft;
      ctx.fillText(s.r2.toFixed(3), pad.l + bw + 6, y + rowH * 0.68);
      ctx.fillStyle = C.inkFaint;
      ctx.fillText(`cv ${s.cv != null ? s.cv.toFixed(2) : '—'}`, w - pad.r + 18, y + rowH * 0.68);
    });
    ctx.fillStyle = C.inkFaint;
    ctx.fillText('条 = r² 解释力 · 虚线 = 门位 · cv = 跨时段稳定性', pad.l - 36, h - 10);
  }

  function drawEvMode(cv, p) {
    const { ctx, w, h } = setupCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px Epilogue, "Noto Sans SC", sans-serif';
    // raw.chroma 是 Float64Array（engine 里 new Float64Array(12)），
    // 下面 max 那句要 concat，必须先转成普通数组
    const chroma = Array.from((p.raw && p.raw.chroma) || []);
    if (!chroma.length) {
      ctx.fillStyle = C.inkFaint;
      ctx.fillText('未留下色度数据', 14, 24);
      return;
    }
    const id = p.identity;
    const evM = p.evidence && p.evidence.mode;
    const gong = id.gongIndex != null ? id.gongIndex
      : (evM && evM.gongRoot != null ? E.PC_NAMES.indexOf(evM.gongRoot) : null);
    const STEPS = [0, 2, 4, 7, 9];
    const rootIdx = E.PC_NAMES.indexOf(id.key);
    const pad = { t: 26, r: 14, b: 34, l: 34 };
    const gw = w - pad.l - pad.r;
    const gh = h - pad.t - pad.b;
    const max = Math.max.apply(null, chroma.concat([0.01]));
    const bw = gw / 12;
    // 水平网格
    ctx.strokeStyle = 'rgba(46,38,32,.08)';
    for (let i = 0; i <= 2; i++) {
      const y = pad.t + (gh * i) / 2;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + gw, y); ctx.stroke();
    }
    chroma.forEach((v, i) => {
      const inSet = gong != null && gong >= 0 && STEPS.includes(((i - gong) % 12 + 12) % 12);
      const bh = Math.max(2, (v / max) * (gh - 8));
      const x = pad.l + i * bw;
      ctx.fillStyle = inSet ? C.terracotta : C.clay;
      ctx.fillRect(x + 3, pad.t + gh - bh, bw - 6, bh);
      ctx.fillStyle = i === rootIdx ? C.ink : C.inkFaint;
      ctx.fillText(E.PC_NAMES[i], x + 3, h - 18);
      if (gong != null && gong >= 0 && i === gong) {
        ctx.fillStyle = C.moss;
        ctx.fillText('宫', x + bw / 2 - 5, pad.t - 8);
      }
      if (i === rootIdx) {
        ctx.fillStyle = C.ink;
        ctx.fillText('主音', Math.min(x + bw / 2 - 10, w - 30), pad.t - 8);
      }
    });
    ctx.fillStyle = C.inkFaint;
    ctx.fillText('柱高 = 色度权重 · 深色 = 宫音五声集合内', pad.l, h - 4);
  }

  function drawEvTonality(cv, p) {
    const { ctx, w, h } = setupCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px Epilogue, "Noto Sans SC", sans-serif';
    const t = p.evidence && p.evidence.tonality;
    const pad = { l: 34, r: 34 };
    const gw = w - pad.l - pad.r;
    if (!t || t.tonality == null) {
      ctx.fillStyle = C.inkFaint;
      ctx.fillText('未标大/小调 —— 无调性证据可画', pad.l, 30);
      return;
    }
    const y = Math.round(h * 0.52);
    const xOf = (v) => pad.l + ((Math.max(-1, Math.min(1, v)) + 1) / 2) * gw;
    // 标尺
    ctx.strokeStyle = 'rgba(46,38,32,.25)';
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + gw, y); ctx.stroke();
    ctx.strokeStyle = 'rgba(46,38,32,.4)';
    const x0 = xOf(0);
    ctx.beginPath(); ctx.moveTo(x0, y - 26); ctx.lineTo(x0, y + 26); ctx.stroke();
    ctx.fillStyle = C.inkFaint;
    ctx.fillText('−1', pad.l - 6, y + 16);
    ctx.fillText('0', x0 - 3, y + 40);
    ctx.fillText('1', pad.l + gw - 8, y + 16);
    const mark = (v, color, label, dy) => {
      const x = xOf(v);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y + dy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(`${label} ${v}`, x + 10, y + dy + 4);
    };
    mark(t.majScore || 0, C.moss, '大调', -14);
    mark(t.minScore || 0, C.terracotta, '小调', 14);
    ctx.fillStyle = C.ink;
    ctx.fillText(
      `差值 ${t.margin != null ? t.margin : '—'} → 判 ${p.identity.tonalityName || t.tonality}`,
      pad.l, 24
    );
  }

  function drawEvLufs(cv) {
    const { ctx, w, h } = setupCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px Epilogue, "Noto Sans SC", sans-serif';
    const lu = state.lufs || {};
    const pad = { l: 34, r: 34 };
    const gw = w - pad.l - pad.r;
    const y = Math.round(h * 0.55);
    const LO = -48, HI = 0;
    const xOf = (v) => pad.l + ((Math.max(LO, Math.min(HI, v)) - LO) / (HI - LO)) * gw;
    ctx.strokeStyle = 'rgba(46,38,32,.25)';
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + gw, y); ctx.stroke();
    ctx.fillStyle = C.inkFaint;
    for (let v = -48; v <= 0; v += 12) {
      const x = xOf(v);
      ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); ctx.stroke();
      ctx.fillText(String(v), x - 8, y + 20);
    }
    // 平台目标刻度。−14/−16 几个目标挤在一起，标签按横向间距
    // 逐行上抬（labelW 一行放得下的距离内换行），免得叠成一团
    const labelW = 58;
    let lastLabelX = -Infinity;
    let labelRow = 0;
    LUFS_TARGETS.filter((t) => t.lufs != null)
      .sort((a, b) => a.lufs - b.lufs)
      .forEach((t) => {
        const x = xOf(t.lufs);
        labelRow = (x - lastLabelX < labelW) ? labelRow + 1 : 0;
        lastLabelX = x;
        ctx.strokeStyle = 'rgba(192,142,58,.8)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x, y - 34); ctx.lineTo(x, y - 8); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = C.ochre;
        ctx.fillText(t.label, Math.min(Math.max(x - 16, 4), w - 76), y - 40 - labelRow * 13);
      });
    const dot = (v, color, label, dy) => {
      if (v == null) return;
      const x = xOf(v);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y + dy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(`${label} ${v.toFixed(1)}`, x + 10, y + dy + 4);
    };
    dot(lu.orig && lu.orig.lufs, C.ink, '原曲', -14);
    dot(lu.proc && lu.proc.lufs, C.terracotta, '精修后', 14);
    if (lu.orig == null || lu.orig.lufs == null) {
      ctx.fillStyle = C.inkFaint;
      ctx.fillText('尚未测得响度', pad.l, 26);
    }
    ctx.fillStyle = C.inkFaint;
    ctx.fillText('LUFS 门限后积分 · 虚线为平台导出目标', pad.l, h - 8);
  }

  function buildEvidenceUI() {
    const tabs = $('#evTabs');
    if (!tabs) return;
    tabs.innerHTML = '';
    EV_TABS.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (t.id === evTab ? ' is-active' : '');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', t.id === evTab ? 'true' : 'false');
      b.textContent = t.label;
      b.addEventListener('click', () => {
        evTab = t.id;
        buildEvidenceUI();
      });
      tabs.appendChild(b);
    });
    drawEvidence();
    renderEvLines();
  }

  /* ============================================================
     ⑥ 原曲五线谱：L1 的 scoreEvents → E.buildScore → 手绘谱面
     · 谱面几何全部手算（系统字体没有音乐字形，高音谱号是贝塞尔曲线画的）
     · 音名拼写跟着调号走：升号调用升号拼写，降号调用降号拼写，
       调号覆盖到的音不画临时记号，没覆盖到的逐音画 ♯/♭/♮
     ============================================================ */
  const BASE_PC = [0, 2, 4, 5, 7, 9, 11];                 // C D E F G A B 的音级
  const SHARP_LETTER = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]; // pc → 音名（升号拼写）
  const FLAT_LETTER = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6];   // pc → 音名（降号拼写）
  const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6];   // 升号顺序 F C G D A E B
  const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];    // 降号顺序 B E A D G C F
  const SHARP_STAFF = [38, 35, 39, 36, 33, 37, 34];  // 升号在高音谱表上的线位
  const FLAT_STAFF = [34, 37, 33, 36, 32, 35, 31];   // 降号的线位
  // 大调主音音级 → 升号个数（负数 = 降号个数）；Gb/Fb 这类罕见调走升号侧兜底
  const MAJOR_TO_SHARPS = {
    0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6,
    5: -1, 10: -2, 3: -3, 8: -4, 1: -5,
  };
  const CARD_BG = '#EBE0CE';   // 谱面纸底 = 卡片底色（#E8DCC7 沙底 × rgba(236,226,209,.72) 合成），全音符符头同色挖空

  /* westernKey（"C 大调"/"A 小调"）→ 调号；小调取关系大调。没检出就 0 个记号，逐音画临时记号。 */
  function scoreKeyState(profile) {
    const id = (profile && profile.identity) || {};
    const m = /^([A-G])\s*(大调|小调)/.exec(id.westernKey || '');
    let sharpN = 0, flatN = 0;
    if (m) {
      let pc = BASE_PC['CDEFGAB'.indexOf(m[1])];
      if (m[2] === '小调') pc = (pc + 3) % 12;
      const n = MAJOR_TO_SHARPS[pc];
      if (n > 0) sharpN = n; else if (n < 0) flatN = -n;
    }
    const keyAcc = {};
    for (let i = 0; i < sharpN; i++) keyAcc[SHARP_ORDER[i]] = 1;
    for (let i = 0; i < flatN; i++) keyAcc[FLAT_ORDER[i]] = -1;
    return { sharpN, flatN, keyAcc, useFlat: flatN > 0 };
  }

  /* 量化事件 → 可画分片：只在小节线处断开（贪心 2 的幂 + 附点），
     同一事件的相邻分片标 tieNext（同音跨小节用连音线接回去）。 */
  function planScorePieces(score) {
    const out = [];
    for (const it of score.items) {
      let off = it.start, rem = it.dur;
      const parts = [];
      while (rem > 0) {
        const barOff = off % score.gridPerBar;
        let take = Math.min(rem, score.gridPerBar - barOff);
        let p = 1;
        while (p * 2 <= take && barOff % (p * 2) === 0) p *= 2;
        if (take - p === p / 2) p *= 1.5;          // 3 / 6 / 12 → 附点
        parts.push({ k: it.k, midi: it.midi, start: off, dur: p });
        off += p; rem -= p;
      }
      parts.forEach((pc, i) => {
        pc.tieNext = i < parts.length - 1 && it.k === 'n';
        out.push(pc);
      });
    }
    return out;
  }

  /* 音高 → 谱面位置 + 临时记号。diatonic idx = 八度*7+音名；底一线 E4 = 30 */
  function noteView(midi, ks) {
    const pc = ((midi % 12) + 12) % 12;
    const L = ks.useFlat ? FLAT_LETTER[pc] : SHARP_LETTER[pc];
    const idx = (Math.floor(midi / 12) - 1) * 7 + L;
    const need = pc - BASE_PC[L];        // 0 | +1（升）| −1（降）
    const inKey = ks.keyAcc[L] || 0;
    let acc = null;
    if (need === inKey && need !== 0) acc = null;      // 调号已覆盖
    else if (need === 0 && inKey !== 0) acc = 'n';     // 调号有、本音是本位
    else if (need === 1) acc = 's';
    else if (need === -1) acc = 'f';
    return { idx, acc };
  }

  function drawBeamBar(ctx, x1, x2, y, sp, up) {
    const th = sp * 0.42;
    ctx.fillStyle = C.ink;
    ctx.fillRect(x1, up ? y - th : y, Math.max(x2 - x1, 0.4), th);
  }

  function drawFlagStrokes(ctx, x, y, sp, up, n) {
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = Math.max(1.2, sp * 0.15);
    ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const dy = y + (up ? 1 : -1) * i * 0.55 * sp;
      ctx.beginPath();
      ctx.moveTo(x, dy);
      ctx.bezierCurveTo(
        x + 0.9 * sp, dy + (up ? 0.45 : -0.45) * sp,
        x + 1.05 * sp, dy + (up ? 1.2 : -1.2) * sp,
        x + 0.15 * sp, dy + (up ? 1.75 : -1.75) * sp
      );
      ctx.stroke();
    }
  }

  /* 高音谱号：一笔画——下钩 → 竖干 → 顶环 → 左侧下行 → 螺旋收进 G 线。
     螺旋从中心左侧（a=π）以向下切线起步，和下行段的来向相接；
     螺旋右缘越过竖干就是字形里那个交叉。参数靠截图回看调过。 */
  function drawGClef(ctx, x0, yT5, sp) {
    const cx = x0 + 1.3 * sp;
    const yG = yT5 + 3 * sp;        // G4 线（idx32，自上而下第四条）
    const yB = yT5 + 4 * sp;        // 底线 E4（idx30）
    const r1 = 0.95 * sp, r0 = 0.1 * sp;
    ctx.save();
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = Math.max(1.3, sp * 0.17);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    // 底钩：自最下方向左上收，接进竖干底端
    ctx.moveTo(cx - 0.45 * sp, yB + 1.95 * sp);
    ctx.bezierCurveTo(
      cx - 1.05 * sp, yB + 1.8 * sp,
      cx - 1.1 * sp, yB + 0.85 * sp,
      cx - 0.05 * sp, yB + 0.55 * sp
    );
    // 竖干向上、略向右倾，到顶线下方 1.1 线距处交给顶环
    ctx.bezierCurveTo(
      cx + 0.55 * sp, yB - 1.8 * sp,
      cx + 0.78 * sp, yT5 - 0.45 * sp,
      cx + 0.5 * sp, yT5 - 1.1 * sp
    );
    // 顶环：向上向左翻过顶点，落在左侧
    ctx.bezierCurveTo(
      cx + 0.3 * sp, yT5 - 2.0 * sp,
      cx - 0.85 * sp, yT5 - 2.05 * sp,
      cx - 0.9 * sp, yT5 - 0.45 * sp
    );
    // 左侧下行，向内收进螺旋入口（中心正左 r1 处，切线朝下）
    ctx.bezierCurveTo(
      cx - 1.4 * sp, yT5 + 0.7 * sp,
      cx - 1.35 * sp, yG - 0.45 * sp,
      cx - r1, yG
    );
    // 螺旋：入口在左、向下绕 1.65 圈收到中心
    const N = 80, turns = 1.65;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const a = Math.PI - t * turns * Math.PI * 2;
      const r = r1 + (r0 - r1) * t;
      ctx.lineTo(cx + Math.cos(a) * r, yG + Math.sin(a) * r);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawRestGlyph(ctx, dur, cx, yOf, sp) {
    ctx.fillStyle = C.ink;
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = Math.max(1.2, sp * 0.15);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (dur >= 16) {
      // 全休止：方块挂在第四线（idx36）下方
      ctx.fillRect(cx - 0.5 * sp, yOf(36), sp, 0.55 * sp);
    } else if (dur >= 8) {
      // 二分（含 12 附点）：方块坐在线 3（idx34）上
      ctx.fillRect(cx - 0.5 * sp, yOf(34) - 0.55 * sp, sp, 0.55 * sp);
      if (dur === 12) {
        ctx.beginPath();
        ctx.arc(cx + 0.85 * sp, yOf(35), sp * 0.13, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (dur >= 3) {
      // 四分（3/6 附点画在右上间）
      ctx.beginPath();
      ctx.moveTo(cx + 0.2 * sp, yOf(36));
      ctx.bezierCurveTo(cx - 0.6 * sp, yOf(35.4), cx + 0.5 * sp, yOf(34.6), cx - 0.45 * sp, yOf(33.6));
      ctx.bezierCurveTo(cx + 0.3 * sp, yOf(32.8), cx - 0.15 * sp, yOf(32.4), cx + 0.25 * sp, yOf(31.6));
      ctx.stroke();
      if (dur === 3 || dur === 6) {
        ctx.beginPath();
        ctx.arc(cx + 0.75 * sp, yOf(35), sp * 0.13, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // 八分 / 十六分：斜干 + 旗钩
      ctx.beginPath();
      ctx.moveTo(cx - 0.5 * sp, yOf(33.2));
      ctx.lineTo(cx + 0.3 * sp, yOf(35.2));
      ctx.stroke();
      const hooks = dur === 1 ? 2 : 1;
      for (let i = 0; i < hooks; i++) {
        const hx = cx + 0.3 * sp, hy = yOf(35.2) + i * 0.75 * sp;
        ctx.beginPath();
        ctx.arc(hx, hy, sp * 0.15, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.bezierCurveTo(hx + 0.45 * sp, hy + 0.2 * sp, hx + 0.4 * sp, hy + 0.55 * sp, hx - 0.05 * sp, hy + 0.55 * sp);
        ctx.stroke();
      }
    }
  }

  function drawScore(cv, score, profile) {
    if (!cv || !score) return;
    const ks = scoreKeyState(profile);
    const pieces = planScorePieces(score);
    let wCss = cv.parentElement ? cv.parentElement.clientWidth : 0;
    if (cv.parentElement) {
      const pcs = getComputedStyle(cv.parentElement);
      wCss -= (parseFloat(pcs.paddingLeft) || 0) + (parseFloat(pcs.paddingRight) || 0);
    }
    wCss = Math.max(wCss, 280);
    const sp = 9;
    const beat = score.den === 8 ? 6 : 4;

    // 音域 → 画布上下留白（加线音也要有地方画）
    let minIdx = 34, maxIdx = 34;
    for (const pc of pieces) {
      if (pc.k !== 'n') continue;
      const v = noteView(pc.midi, ks);
      pc.idx = v.idx; pc.acc = v.acc;
      if (v.idx < minIdx) minIdx = v.idx;
      if (v.idx > maxIdx) maxIdx = v.idx;
    }
    const topPad = 3.2 * sp + Math.max(0, maxIdx - 40) * sp / 2;
    const botPad = 3.6 * sp + Math.max(0, 28 - minIdx) * sp / 2;
    const rowH = topPad + 4 * sp + botPad;

    const marginX = 0.5 * sp;
    const headerW = 2.9 * sp + (ks.sharpN + ks.flatN) * 1.15 * sp + 3.8 * sp;
    const contentW = Math.max(wCss - marginX - headerW - 1.5 * sp, 60);
    const minU = 1.35 * sp;
    let bpr = Math.max(1, Math.floor(contentW / (score.gridPerBar * minU)));
    bpr = Math.min(bpr, score.bars);
    const nRows = Math.ceil(score.bars / bpr);
    const uw = contentW / (bpr * score.gridPerBar);
    const hCss = Math.ceil(nRows * rowH + 1.6 * sp);

    cv.dataset.cssH = String(hCss);
    const { ctx, w } = setupCanvas(cv);
    // 先铺纸底：页面上与卡片同色，导出 PNG 时背景不透明
    ctx.fillStyle = CARD_BG;
    ctx.fillRect(0, 0, w, hCss);
    const lineW = Math.max(1, sp * 0.11);

    for (let row = 0; row < nRows; row++) {
      const b0 = row * bpr;
      const b1 = Math.min(score.bars, b0 + bpr);
      const u0 = b0 * score.gridPerBar;
      const rowY = row * rowH;
      const yT5 = rowY + topPad;
      const yB = yT5 + 4 * sp;
      const yOf = (idx) => yB - (idx - 30) * (sp / 2);
      const x0 = marginX + headerW;
      const X = (u) => x0 + (u - u0) * uw;

      // 五条线（末行到终止线为止，不往右甩空线）
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = lineW;
      ctx.lineCap = 'butt';
      const staffRight = b1 === score.bars
        ? Math.min(w - marginX, x0 + (b1 * score.gridPerBar - u0) * uw + 0.7 * sp)
        : w - marginX;
      for (let li = 30; li <= 38; li += 2) {
        ctx.beginPath();
        ctx.moveTo(marginX, yOf(li));
        ctx.lineTo(staffRight, yOf(li));
        ctx.stroke();
      }

      // 谱号 + 调号 + 拍号
      drawGClef(ctx, marginX, yT5, sp);
      let kx = marginX + 2.9 * sp;
      ctx.fillStyle = C.ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${Math.round(sp * 1.55)}px "Songti SC","Times New Roman",serif`;
      for (let i = 0; i < ks.sharpN; i++) {
        ctx.fillText('♯', kx + 0.5 * sp, yOf(SHARP_STAFF[i]));
        kx += 1.15 * sp;
      }
      for (let i = 0; i < ks.flatN; i++) {
        ctx.fillText('♭', kx + 0.5 * sp, yOf(FLAT_STAFF[i]));
        kx += 1.15 * sp;
      }
      kx += 1.0 * sp;
      ctx.font = `700 ${Math.round(sp * 1.6)}px Georgia,"Times New Roman",serif`;
      ctx.fillText(String(score.num), kx + 0.7 * sp, (yOf(38) + yOf(34)) / 2);
      ctx.fillText(String(score.den), kx + 0.7 * sp, (yOf(34) + yOf(30)) / 2);

      // 小节号（行首上方）
      ctx.font = `600 ${Math.round(sp * 0.85)}px ui-sans-serif,system-ui,sans-serif`;
      ctx.fillStyle = C.inkFaint;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(String(b0 + 1), x0 - 0.3 * sp, yT5 - 0.7 * sp);

      // 小节线（行首由头部区带出；最后一根是终止线）
      ctx.strokeStyle = C.ink;
      ctx.fillStyle = C.ink;
      ctx.lineWidth = lineW;
      for (let b = b0 + 1; b <= b1; b++) {
        const bx = X(b * score.gridPerBar);
        ctx.beginPath();
        ctx.moveTo(bx, yT5);
        ctx.lineTo(bx, yB);
        ctx.stroke();
        if (b === score.bars) ctx.fillRect(bx + sp * 0.2, yT5, sp * 0.3, 4 * sp);
      }

      // 本行事件
      const rowPieces = pieces.filter((p) => p.start >= u0 && p.start < u1(score, b1));
      const disp = rowPieces.map((p) => {
        const d = { p, x: X(p.start) + Math.min(0.75 * sp, uw * 0.45) };
        if (p.k === 'n') { d.idx = p.idx; d.y = yOf(p.idx); d.stemUp = p.idx <= 34; }
        return d;
      });

      // 分组：休止与长音打断符杠；同一拍内连续短音成组
      const runs = [];
      let cur = [];
      for (const d of disp) {
        if (d.rest || d.p.k === 'r') { if (cur.length) { runs.push(cur); cur = []; } continue; }
        if (d.p.dur > 2) {
          if (cur.length) { runs.push(cur); cur = []; }
          runs.push([d]);
          continue;
        }
        const prev = cur[cur.length - 1];
        if (prev && Math.floor(d.p.start / beat) !== Math.floor(prev.p.start / beat)) {
          runs.push(cur); cur = [];
        }
        cur.push(d);
      }
      if (cur.length) runs.push(cur);

      // 加线
      ctx.lineWidth = Math.max(1, sp * 0.13);
      for (const d of disp) {
        if (d.p.k !== 'n') continue;
        const led = (e) => {
          const ly = yOf(e);
          ctx.beginPath();
          ctx.moveTo(d.x - 1.15 * sp, ly);
          ctx.lineTo(d.x + 1.15 * sp, ly);
          ctx.stroke();
        };
        if (d.idx < 30) for (let e = (d.idx % 2 === 0 ? d.idx : d.idx - 1); e <= 28; e += 2) led(e);
        if (d.idx > 38) for (let e = (d.idx % 2 === 0 ? d.idx : d.idx + 1); e >= 40; e -= 2) led(e);
      }

      // 符干 + 符杠 / 旗
      const HEAD_RX = 0.62 * sp, HEAD_RY = 0.46 * sp;
      for (const run of runs) {
        if (run.length >= 2) {
          const avg = run.reduce((s, d) => s + d.idx, 0) / run.length;
          const up = avg <= 34;
          for (const d of run) d.stemUp = up;
          const beamY = up
            ? Math.min(...run.map((d) => d.y)) - 3.4 * sp
            : Math.max(...run.map((d) => d.y)) + 3.4 * sp;
          for (const d of run) d.beamY = beamY;
        }
        for (const d of run) {
          if (d.p.dur >= 16) continue;              // 全音符无干
          const up = d.stemUp;
          const sx = d.x + (up ? HEAD_RX : -HEAD_RX);
          const endY = d.beamY != null ? d.beamY : d.y + (up ? -3.3 * sp : 3.3 * sp);
          ctx.strokeStyle = C.ink;
          ctx.lineWidth = Math.max(1.2, sp * 0.14);
          ctx.beginPath();
          ctx.moveTo(sx, d.y);
          ctx.lineTo(sx, endY);
          ctx.stroke();
          if (d.beamY == null && d.p.dur <= 2) {
            drawFlagStrokes(ctx, sx, endY, sp, up, d.p.dur === 1 ? 2 : 1);
          }
        }
      }
      // 符杠实体（主杠 + 十六分的第二杠）
      for (const run of runs) {
        if (run.length < 2) continue;
        const xs = run.map((d) => d.x + (d.stemUp ? HEAD_RX : -HEAD_RX));
        const up = run[0].stemUp;
        const beamY = run[0].beamY;
        drawBeamBar(ctx, Math.min(...xs), Math.max(...xs), beamY, sp, up);
        for (let i = 0; i < run.length; i++) {
          if (run[i].p.dur !== 1) continue;
          let j = -1;
          if (i + 1 < run.length && run[i + 1].p.dur === 1) j = i + 1;
          else if (i > 0 && run[i - 1].p.dur === 1) j = i - 1;
          let a, b;
          if (j >= 0) { a = xs[i]; b = xs[j]; }
          else {
            const dir = i + 1 < run.length ? 1 : -1;
            a = xs[i]; b = xs[i] + dir * 1.3 * sp;
          }
          const off = up ? -0.62 * sp : 0.62 * sp;
          drawBeamBar(ctx, Math.min(a, b), Math.max(a, b), beamY + off, sp, up);
        }
      }

      // 符头
      for (const d of disp) {
        if (d.p.k !== 'n') continue;
        const open = d.p.dur >= 8;
        ctx.save();
        ctx.translate(d.x, d.y);
        ctx.rotate(-0.35);
        ctx.beginPath();
        ctx.ellipse(0, 0, HEAD_RX, HEAD_RY, 0, 0, Math.PI * 2);
        if (open) {
          ctx.fillStyle = CARD_BG;
          ctx.fill();
          ctx.strokeStyle = C.ink;
          ctx.lineWidth = Math.max(1.2, sp * 0.13);
          ctx.stroke();
        } else {
          ctx.fillStyle = C.ink;
          ctx.fill();
        }
        ctx.restore();

        // 附点（落在线上就挪到上方的间）
        if (d.p.dur === 3 || d.p.dur === 6 || d.p.dur === 12) {
          const dy = d.idx % 2 === 0 ? yOf(d.idx + 1) : d.y;
          ctx.beginPath();
          ctx.arc(d.x + HEAD_RX + 0.32 * sp, dy, sp * 0.13, 0, Math.PI * 2);
          ctx.fillStyle = C.ink;
          ctx.fill();
        }
        // 临时记号
        if (d.acc) {
          const sym = d.acc === 's' ? '♯' : d.acc === 'f' ? '♭' : '♮';
          ctx.font = `bold ${Math.round(sp * 1.35)}px "Songti SC","Times New Roman",serif`;
          ctx.fillStyle = C.ink;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(sym, d.x - HEAD_RX - 0.25 * sp, d.y);
          ctx.textBaseline = 'alphabetic';
        }
      }

      // 连音线（同音分片的接缝）
      for (let i = 0; i < disp.length - 1; i++) {
        const d = disp[i], nx = disp[i + 1];
        if (!d.p.tieNext || d.p.k !== 'n' || nx.p.k !== 'n') continue;
        const x1 = d.x + HEAD_RX, x2 = nx.x - HEAD_RX;
        if (x2 <= x1 + 2) continue;
        const up = d.beamY != null ? d.stemUp : d.idx <= 34;
        const y = up
          ? Math.max(d.y, nx.y) + HEAD_RY + 0.3 * sp
          : Math.min(d.y, nx.y) - HEAD_RY - 0.3 * sp;
        const sag = (up ? 1 : -1) * 0.55 * sp;
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.quadraticCurveTo((x1 + x2) / 2, y + sag, x2, y);
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = Math.max(1.2, sp * 0.14);
        ctx.stroke();
      }

      // 休止符
      for (const p of rowPieces) {
        if (p.k !== 'r') continue;
        drawRestGlyph(ctx, p.dur, X(p.start) + p.dur * uw / 2, yOf, sp);
      }
    }

    function u1(s, bb) { return bb * s.gridPerBar; }
  }

  /* 卡片编排：标签、诚实声明、画布；旧档案没有 scoreEvents 就明说 */
  function renderScoreCard(profile) {
    const cv = $('#chartScore');
    if (!cv) return;
    const id = (profile && profile.identity) || {};
    const tagK = $('#scoreKeyTag');
    const tagM = $('#scoreMeterTag');
    const tagB = $('#scoreBpmTag');
    const note = $('#scoreNote');
    const btn = $('#btnScorePng');
    if (tagK) {
      tagK.textContent = id.westernKey ||
        (id.key && id.modeName ? `${id.key} ${id.modeName}` : '调性未定');
    }
    if (tagM) tagM.textContent = id.meter || '拍号未定 · 按 4/4';
    if (tagB) tagB.textContent = id.bpm ? `${id.bpm.toFixed(1)} BPM` : '— BPM';

    const evts = profile && profile.melody && profile.melody.scoreEvents;
    const score = (evts && evts.length)
      ? E.buildScore(evts, {
          bpm: id.bpm, meter: id.meter,
          sampleRate: profile.meta && profile.meta.sampleRate,
        })
      : null;
    state.score = score;
    if (btn) btn.disabled = !score;
    const btnXml = $('#btnScoreXml');
    if (btnXml) btnXml.disabled = !score;

    if (!score) {
      const s = setupCanvas(cv);
      s.ctx.fillStyle = CARD_BG;
      s.ctx.fillRect(0, 0, s.w, s.h);
      if (note) note.textContent = '旧档案无记谱数据 · 重新体检后可出谱';
      return;
    }
    if (note) note.textContent = '基于主导音高轨迹记谱 · 复音混音为近似，非精确转写';
    drawScore(cv, score, profile);
  }

  /* ---------- 五线谱 → MusicXML（可进 MuseScore 等打谱软件的工程文件） ----------
     全部字段取自 buildScore 的实测模型：divisions=4（单位就是 1/16 拍），
     凑不满一个常规时值的用连音线拆（16/12/8/6/4/3/2/1 贪心取大），
     小节内空隙补休止符，配平到 gridPerBar。与谱面渲染共用
     planScorePieces 的小节线切割口径——导出的和画在屏上的是同一份谱。 */
  const XML_TYPE = {
    16: 'whole', 12: 'half', 8: 'half', 6: 'quarter',
    4: 'quarter', 3: 'eighth', 2: 'eighth', 1: 'sixteenth',
  };
  const XML_DOTS = { 12: 1, 6: 1, 3: 1 };
  const XML_DECOMP = [16, 12, 8, 6, 4, 3, 2, 1];

  function xmlSplitDur(d) {
    const out = [];
    let rem = Math.max(1, Math.round(d));
    while (rem > 0) {
      const c = XML_DECOMP.find((x) => x <= rem) || 1;
      out.push(c);
      rem -= c;
    }
    return out;
  }

  function xmlEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildMusicXml(score, profile) {
    if (!score || !score.items || !score.bars) return null;
    const id = (profile && profile.identity) || {};
    const ks = scoreKeyState(profile);
    const fifths = ks.sharpN - ks.flatN;
    const minor = /小调/.test(id.westernKey || '');
    const G = score.gridPerBar;
    const pieces = planScorePieces(score);
    const bpm = Math.round((score.bpm || 90) * 10) / 10;

    const pitchOf = (midi) => {
      const pc = ((midi % 12) + 12) % 12;
      const l = ks.useFlat ? FLAT_LETTER[pc] : SHARP_LETTER[pc];
      let alter = pc - BASE_PC[l];
      if (alter > 6) alter -= 12;
      if (alter < -6) alter += 12;
      return { step: 'CDEFGAB'[l], alter, octave: Math.floor(midi / 12) - 1, letter: l };
    };

    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
    out.push('<score-partwise version="3.1">');
    const src = state.profile && state.profile.meta
      ? baseName(state.profile.meta.source_file) : '';
    if (src) out.push(`  <work><work-title>${xmlEsc(src)}</work-title></work>`);
    out.push('  <identification><encoding><software>SonicPixel 音智新媒</software></encoding></identification>');
    out.push('  <part-list><score-part id="P1"><part-name>主导旋律</part-name></score-part></part-list>');
    out.push('  <part id="P1">');

    let pendingTie = false;   // 上一件是连音线开段（跨小节续音）
    const pushRest = (dur) => {
      pendingTie = false;     // 休止不承接连音线（结构上不该发生，防御）
      for (const c of xmlSplitDur(dur)) {
        out.push(`      <note><rest/><duration>${c}</duration><voice>1</voice>` +
          `<type>${XML_TYPE[c]}</type>${XML_DOTS[c] ? '<dot/>' : ''}</note>`);
      }
    };
    const pushNote = (midi, dur, tieNext) => {
      const p = pitchOf(midi);
      const keyAcc = ks.keyAcc[p.letter] || 0;
      const accEl = p.alter !== keyAcc
        ? `<accidental>${p.alter > 0 ? 'sharp' : p.alter < 0 ? 'flat' : 'natural'}</accidental>`
        : '';
      const alterEl = p.alter !== 0 ? `<alter>${p.alter}</alter>` : '';
      const comps = xmlSplitDur(dur);
      comps.forEach((c, i) => {
        const startTie = i < comps.length - 1 || !!tieNext;
        const stopTie = i > 0 || pendingTie;
        const ties = (startTie ? '<tie type="start"/>' : '') + (stopTie ? '<tie type="stop"/>' : '');
        const nots = (startTie ? '<tied type="start"/>' : '') + (stopTie ? '<tied type="stop"/>' : '');
        out.push(`      <note><pitch><step>${p.step}</step>${alterEl}<octave>${p.octave}</octave></pitch>` +
          `<duration>${c}</duration>${ties}<voice>1</voice><type>${XML_TYPE[c]}</type>` +
          `${XML_DOTS[c] ? '<dot/>' : ''}${accEl}` +
          `${nots ? `<notations>${nots}</notations>` : ''}</note>`);
      });
      pendingTie = !!tieNext;
    };

    let pi = 0;
    for (let m = 1; m <= score.bars; m++) {
      const mStart = (m - 1) * G;
      const mEnd = m * G;
      out.push(`    <measure number="${m}">`);
      if (m === 1) {
        out.push('      <attributes>');
        out.push('        <divisions>4</divisions>');
        out.push(`        <key><fifths>${fifths}</fifths><mode>${minor ? 'minor' : 'major'}</mode></key>`);
        out.push(`        <time><beats>${score.num}</beats><beat-type>${score.den}</beat-type></time>`);
        out.push('        <clef><sign>G</sign><line>2</line></clef>');
        out.push('      </attributes>');
        out.push('      <direction placement="above"><direction-type><metronome>' +
          `<beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute>` +
          '</metronome></direction-type>' +
          `<sound tempo="${bpm}"/></direction>`);
      }
      let cur = mStart;
      while (pi < pieces.length && pieces[pi].start < mEnd) {
        const pc = pieces[pi];
        if (pc.start > cur) pushRest(pc.start - cur);   // 量化四舍五入留下的空隙
        if (pc.k === 'n') pushNote(pc.midi, pc.dur, pc.tieNext);
        else pushRest(pc.dur);
        cur = pc.start + pc.dur;
        pi++;
      }
      if (cur < mEnd) {
        if (cur === mStart) {
          // 整小节休止：MusicXML 标准写法
          out.push(`      <note><rest measure="yes"/><duration>${G}</duration><voice>1</voice></note>`);
        } else {
          pushRest(mEnd - cur);
        }
      }
      out.push('    </measure>');
    }
    out.push('  </part>');
    out.push('</score-partwise>');
    return out.join('\n');
  }

  /* ---------- 响度走势（短时 LUFS 心电图） ----------
     3 秒短时窗曲线由 E.loudnessCurve 出（引擎侧，口径见其注释）；
     这里只管算的时机和画。平台目标线只画不吃——真正对齐发生在
     「导出精修音频」里（matchLoudness），导出后把对齐版曲线换上来。 */
  function updateLoudCurve(which) {
    if (!state.loudCurve) state.loudCurve = { orig: null, proc: null };
    try {
      if (which !== 'proc' && state.originBuffer) {
        state.loudCurve.orig = E.loudnessCurve(state.originBuffer);
      }
      if (which !== 'orig') {
        state.loudCurve.proc = state.processedBuffer
          ? E.loudnessCurve(state.processedBuffer) : null;
      }
    } catch (err) {
      console.info('[loudcurve]', err);
    }
    drawLoudCurve($('#chartLoudCurve'));
  }

  function setLoudCurveProc(buf) {
    if (!state.loudCurve) state.loudCurve = { orig: null, proc: null };
    try {
      state.loudCurve.proc = buf ? E.loudnessCurve(buf) : null;
    } catch (err) {
      console.info('[loudcurve]', err);
    }
    drawLoudCurve($('#chartLoudCurve'));
  }

  function drawLoudCurve(cv) {
    if (!cv) return;
    const { ctx, w, h } = setupCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    const font = '11px Epilogue, "Noto Sans SC", sans-serif';
    const lc = state.loudCurve;
    const curves = [];
    if (lc && lc.orig && lc.orig.lufs.length) {
      curves.push({ c: lc.orig, color: C.clay, width: 1.7 });
    }
    if (lc && lc.proc && lc.proc.lufs.length) {
      curves.push({ c: lc.proc, color: C.terracotta, width: 2.1 });
    }
    const target = lufsTargetOf();
    if (!curves.length) {
      ctx.fillStyle = C.inkFaint;
      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.fillText('体检后显示原曲短时响度曲线', w / 2, h / 2);
      return;
    }

    // y 范围：忽略接近静音的窗口（> −60 才参与定界），保证动态够用
    let hi = -Infinity, lo = Infinity;
    for (const cu of curves) {
      for (const v of cu.c.lufs) {
        if (v > hi) hi = v;
        if (v > -60 && v < lo) lo = v;
      }
    }
    if (!isFinite(lo)) lo = hi - 36;
    if (target.lufs != null) {
      hi = Math.max(hi, target.lufs);
      lo = Math.min(lo, target.lufs);
    }
    hi = Math.min(Math.ceil((hi + 2) / 6) * 6, 0);
    lo = Math.max(Math.floor((lo - 2) / 6) * 6, -70);
    if (hi - lo < 18) lo = Math.max(hi - 18, -70);

    const padL = 42, padR = 14, padT = 14, padB = 24;
    const x0 = padL, x1 = Math.max(w - padR, x0 + 40);
    const y0 = padT, y1 = Math.max(h - padB, y0 + 40);
    let maxT = 0;
    for (const cu of curves) {
      maxT = Math.max(maxT, cu.c.times[cu.c.times.length - 1] || 0);
    }
    const X = (t) => x0 + (maxT > 0 ? t / maxT : 0) * (x1 - x0);
    const Y = (v) => y1 - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (y1 - y0);

    // 网格与刻度（每 6 dB）
    ctx.font = font;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    for (let v = lo; v <= hi + 0.001; v += 6) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = 'rgba(46,38,32,.10)';
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillStyle = C.inkFaint;
      ctx.fillText(String(v), x0 - 6, y + 3.5);
    }
    ctx.textAlign = 'center';
    const stepT = maxT > 40 ? 15 : maxT > 18 ? 10 : 5;
    for (let t = 0; t <= maxT + 0.001; t += stepT) {
      ctx.fillStyle = C.inkFaint;
      ctx.fillText(Math.round(t) + 's', X(t), y1 + 15);
    }

    // 平台目标线（虚线；对齐动作在导出里，这里只标位置）
    if (target.lufs != null) {
      const ty = Math.round(Y(target.lufs)) + 0.5;
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = C.moss;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x0, ty); ctx.lineTo(x1, ty); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = C.moss;
      ctx.textAlign = 'left';
      ctx.fillText(target.label, x0 + 6, ty - 5);   // label 已含数值，勿再拼 lufs
    }

    // 曲线：原曲在下，精修后压上
    for (const cu of curves) {
      ctx.strokeStyle = cu.color;
      ctx.lineWidth = cu.width;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const ts = cu.c.times, vs = cu.c.lufs;
      for (let i = 0; i < ts.length; i++) {
        const px = X(ts[i]), py = Y(vs[i]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }

  /* ---------- ② 平台响度合规导出 ---------- */
  const LUFS_TARGETS = [
    { id: 'off', label: '不调整', lufs: null },
    { id: 'spotify', label: 'Spotify −14', lufs: -14 },
    { id: 'apple', label: 'Apple −16', lufs: -16 },
    { id: 'youtube', label: 'YouTube −14', lufs: -14 },
    { id: 'ebu', label: 'EBU −23', lufs: -23 },
  ];
  const lufsTargetOf = () =>
    LUFS_TARGETS.find((t) => t.id === state.lufsTarget) || LUFS_TARGETS[0];

  function buildLufsTargets() {
    const wrap = $('#lufsTargets');
    if (!wrap) return;
    wrap.innerHTML = '';
    LUFS_TARGETS.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', t.id === state.lufsTarget ? 'true' : 'false');
      b.dataset.lufsTarget = t.id;
      b.textContent = t.label;
      b.addEventListener('click', () => {
        state.lufsTarget = t.id;
        buildLufsTargets();
        drawLoudCurve($('#chartLoudCurve'));   // 目标线跟着换
        scheduleSave();
      });
      wrap.appendChild(b);
    });
    updateLufsState();
  }

  function updateLufsState() {
    const el = $('#lufsState');
    if (!el) return;
    const lu = state.lufs;
    const t = lufsTargetOf();
    const parts = [];
    if (lu && lu.orig && lu.orig.lufs != null) parts.push(`原曲 ${lu.orig.lufs} LUFS`);
    if (lu && lu.proc && lu.proc.lufs != null) parts.push(`精修后 ${lu.proc.lufs} LUFS`);
    if (t.lufs != null) parts.push(`目标 ${t.lufs}`);
    el.textContent = parts.length ? parts.join(' · ') : '未测量';
    el.title = '实测为 BS.1770 K 加权、400ms 块门限后的积分响度';
  }

  /* ---------- ③ 响度匹配盲听 A/B ---------- */
  const blind = {
    active: false, revealed: false,
    map: null,           // { A: 'orig'|'proc', B: ... }
    nodes: null,         // [{ src, gain, g }]
    lvlA: 1, lvlB: 1,
    sel: 'A',
  };

  function blindUIInit() {
    const start = $('#btnBlindStart');
    if (start) { start.disabled = false; start.textContent = '开始盲听'; }
    ['#btnBlindReveal', '#btnBlindStop', '#blindA', '#blindB'].forEach((s) => {
      const el = $(s);
      if (el) el.disabled = true;
    });
    ['#blindA', '#blindB'].forEach((s) => {
      const el = $(s);
      if (el) el.setAttribute('aria-pressed', 'false');
    });
    const res = $('#blindResult');
    if (res) res.hidden = true;
    const tag = $('#blindTag');
    if (tag) tag.textContent = '未开始';
    const pick = $('#blindPickTag');
    if (pick) pick.textContent = '';
  }

  function stopBlind() {
    const nodes = blind.nodes;
    blind.nodes = null;
    blind.active = false;
    blind.revealed = false;
    blind.map = null;
    blind.sel = 'A';
    if (nodes) {
      nodes.forEach((n) => {
        try { n.src.onended = null; n.src.stop(0); } catch (_) {}
        try { n.gain.disconnect(); } catch (_) {}
      });
    }
    blindUIInit();
  }

  async function blindStart() {
    if (!state.originBuffer || !state.processedBuffer) {
      setStatus('先执行精修，才有两版可盲听。', false);
      return;
    }
    stopAll();  // 停走带与旧盲听（stopAll 内会调 stopBlind 归位 UI）
    const tag = $('#blindTag');
    const btn = $('#btnBlindStart');
    if (tag) tag.textContent = '测量响度…';
    if (btn) btn.disabled = true;
    try {
      const luO = E.measureLoudness(state.originBuffer);
      const luP = E.measureLoudness(state.processedBuffer);
      if (luO.lufs == null || luP.lufs == null) {
        if (tag) tag.textContent = '响度测不出，无法等响盲听';
        if (btn) btn.disabled = false;
        return;
      }
      // 等响：两版都降到更小的那个 LUFS，再随机分配 A/B
      const target = Math.min(luO.lufs, luP.lufs);
      const gO = Math.pow(10, (target - luO.lufs) / 20);
      const gP = Math.pow(10, (target - luP.lufs) / 20);
      const flip = Math.random() < 0.5;
      blind.map = flip ? { A: 'proc', B: 'orig' } : { A: 'orig', B: 'proc' };

      const ctx = getCtx();
      ctx.resume && ctx.resume();
      const bufFor = (side) =>
        (blind.map[side] === 'orig' ? state.originBuffer : state.processedBuffer);
      const gFor = (side) => (blind.map[side] === 'orig' ? gO : gP);
      const mk = (side) => {
        const src = ctx.createBufferSource();
        src.buffer = bufFor(side);
        const gain = ctx.createGain();
        gain.gain.value = 0;
        src.connect(gain);
        gain.connect(ctx.destination);
        return { src, gain, g: gFor(side) };
      };
      const a = mk('A');
      const b = mk('B');
      const t0 = ctx.currentTime + 0.08;
      a.src.start(t0, 0);
      b.src.start(t0, 0);
      a.gain.gain.setValueAtTime(a.g, t0);
      b.gain.gain.setValueAtTime(0, t0);
      blind.nodes = [a, b];
      blind.lvlA = a.g;
      blind.lvlB = b.g;
      blind.active = true;
      blind.revealed = false;
      blind.sel = 'A';
      const end = () => {
        if (!blind.active) return;
        if (tag) tag.textContent = '两版放完 · 可再点开始重听';
        stopBlind();
      };
      a.src.onended = end;
      b.src.onended = end;

      ['#blindA', '#blindB', '#btnBlindReveal', '#btnBlindStop'].forEach((s) => {
        const el = $(s);
        if (el) el.disabled = false;
      });
      if (btn) { btn.textContent = '盲听中…'; btn.disabled = true; }
      blindSwitch('A');
      if (tag) tag.textContent = `等响 ${target.toFixed(1)} LUFS · 随机分配，你听 A`;
    } catch (err) {
      console.error('[blind]', err);
      if (tag) tag.textContent = '盲听启动失败';
      if (btn) btn.disabled = false;
    }
  }

  function blindSwitch(side) {
    if (!blind.active || !blind.nodes) return;
    blind.sel = side;
    const ctx = getCtx();
    const t = ctx.currentTime;
    const a = blind.nodes[0], b = blind.nodes[1];
    a.gain.gain.setTargetAtTime(side === 'A' ? blind.lvlA : 0, t, 0.005);
    b.gain.gain.setTargetAtTime(side === 'B' ? blind.lvlB : 0, t, 0.005);
    const ea = $('#blindA'), eb = $('#blindB');
    if (ea) ea.setAttribute('aria-pressed', side === 'A' ? 'true' : 'false');
    if (eb) eb.setAttribute('aria-pressed', side === 'B' ? 'true' : 'false');
    if (!blind.revealed) {
      const tag = $('#blindTag');
      if (tag) tag.textContent = `随机分配 · 你听 ${side}（还不知道是谁）`;
    }
  }

  function blindReveal() {
    if (!blind.active || blind.revealed || !blind.map) return;
    blind.revealed = true;
    const nameOf = (x) => (x === 'orig' ? '原始' : '精修');
    const tag = $('#blindTag');
    if (tag) tag.textContent = `A = ${nameOf(blind.map.A)} · B = ${nameOf(blind.map.B)} · 继续可切听`;
    const btn = $('#btnBlindReveal');
    if (btn) btn.disabled = true;
    const res = $('#blindResult');
    if (res) res.hidden = false;
    const pick = $('#blindPickTag');
    if (pick) pick.textContent = '两边都听过后再选';
  }

  function blindPick(side) {
    if (!blind.active || !blind.revealed || !blind.map) return;
    const winner = blind.map[side];
    const pick = $('#blindPickTag');
    if (pick) pick.textContent = `你选的 ${side} = ${winner === 'orig' ? '原始版' : '精修版'}`;
    setStatus(`盲听已选 ${side}（${winner === 'orig' ? '原始' : '精修'}）`, false);
  }

  /* ---------- ④ 结构可编辑的再生 ---------- */
  // 把体检结构规范成首尾相接、覆盖整曲的可拼接序列：
  // 结构划分若留缝隙或重叠，直接拿去 splice 会丢时间或叠音。
  function normalizeSegments(segments, duration) {
    const plan = [];
    let cursor = 0;
    (segments || []).forEach((seg) => {
      const s = Math.max(cursor, Math.min(seg.start, duration));
      const e = Math.max(s, Math.min(seg.end, duration));
      if (e - s < 0.05) return;
      plan.push({ s, e, l: seg.section });
      cursor = e;
    });
    if (plan.length && duration && plan[plan.length - 1].e < duration - 0.05) {
      plan[plan.length - 1].e = duration;
    }
    return plan;
  }

  function buildStructPlan() {
    const p = state.profile;
    state.structPlan = p ? normalizeSegments(p.structure, p.meta.duration) : null;
    state.structSel = state.structPlan && state.structPlan.length ? 0 : -1;
    state.structDirty = false;
    renderStructPlan();
    const apply = $('#btnStructApply');
    if (apply) apply.disabled = true;
    const reset = $('#btnStructReset');
    if (reset) reset.disabled = !state.structHistory.length;
    const st = $('#structState');
    if (st) st.textContent = '未改动';
  }

  function renderStructPlan() {
    const wrap = $('#structPlan');
    if (!wrap) return;
    wrap.innerHTML = '';
    (state.structPlan || []).forEach((seg, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (i === state.structSel ? ' is-sel' : '');
      b.dataset.i = String(i);
      b.textContent = `${seg.l} ${seg.s.toFixed(0)}–${seg.e.toFixed(0)}s`;
      b.addEventListener('click', () => {
        state.structSel = i;
        renderStructPlan();
      });
      wrap.appendChild(b);
    });
  }

  function structTouched(msg) {
    state.structDirty = true;
    const apply = $('#btnStructApply');
    if (apply) apply.disabled = false;
    const st = $('#structState');
    if (st) st.textContent = msg || '待应用';
    renderStructPlan();
  }

  function structDup() {
    const i = state.structSel, pl = state.structPlan;
    if (!pl || i < 0 || i >= pl.length) return;
    pl.splice(i + 1, 0, { ...pl[i] });
    state.structSel = i + 1;
    structTouched(`已重复第 ${i + 1} 段 · 共 ${pl.length} 段`);
  }

  function structDel() {
    const i = state.structSel, pl = state.structPlan;
    if (!pl || i < 0 || i >= pl.length) return;
    if (pl.length <= 1) {
      const st = $('#structState');
      if (st) st.textContent = '至少保留一段';
      return;
    }
    pl.splice(i, 1);
    state.structSel = Math.min(i, pl.length - 1);
    structTouched(`删除第 ${i + 1} 段 · 共 ${pl.length} 段`);
  }

  function structMerge() {
    const i = state.structSel, pl = state.structPlan;
    if (!pl || i < 0 || i >= pl.length - 1) {
      const st = $('#structState');
      if (st) st.textContent = '已是最后一段，无后可并';
      return;
    }
    pl[i].e = pl[i + 1].e;
    pl[i].l = `${pl[i].l}+${pl[i + 1].l}`;
    pl.splice(i + 1, 1);
    structTouched(`第 ${i + 1} 段与后段合并 · 共 ${pl.length} 段`);
  }

  function structLeft() {
    const i = state.structSel, pl = state.structPlan;
    if (!pl || i <= 0 || i >= pl.length) return;
    const tmp = pl[i - 1];
    pl[i - 1] = pl[i];
    pl[i] = tmp;
    state.structSel = i - 1;
    structTouched(`第 ${i + 1} 段前移 · 共 ${pl.length} 段`);
  }

  /* 按计划段拼接音频：15ms 等功率（sqrt）交叉淡化，
     接缝两侧一个淡出一个淡入，能量相加守恒，不爆音不掉音。 */
  function spliceSegments(src, plan) {
    if (!src || !plan || plan.length < 1) return null;
    const sr = src.sampleRate, nCh = src.numberOfChannels;
    const XF = Math.max(1, Math.round(sr * 0.015));
    const ranges = [];
    plan.forEach((seg) => {
      const i0 = Math.max(0, Math.min(src.length, Math.round(seg.s * sr)));
      const i1 = Math.max(i0, Math.min(src.length, Math.round(seg.e * sr)));
      if (i1 > i0) ranges.push([i0, i1]);
    });
    if (!ranges.length) return null;
    const seams = ranges.map((r, idx) => {
      if (idx === ranges.length - 1) return 0;
      const nextLen = ranges[idx + 1][1] - ranges[idx + 1][0];
      return Math.min(XF, Math.floor((r[1] - r[0]) / 2), Math.floor(nextLen / 2));
    });
    let total = 0;
    ranges.forEach((r, idx) => { total += (r[1] - r[0]) - seams[idx]; });
    const out = new AudioBuffer({
      length: Math.max(1, total), numberOfChannels: nCh, sampleRate: sr,
    });
    let cursor = 0;
    for (let idx = 0; idx < ranges.length; idx++) {
      const r = ranges[idx];
      const len = r[1] - r[0];
      const fOut = seams[idx];
      const fIn = idx > 0 ? seams[idx - 1] : 0;
      for (let c = 0; c < nCh; c++) {
        const sd = src.getChannelData(c);
        const dd = out.getChannelData(c);
        for (let i = 0; i < len; i++) {
          let g = 1;
          if (fIn && i < fIn) g *= Math.sqrt(i / fIn);
          if (fOut && i >= len - fOut) g *= Math.sqrt((len - 1 - i) / fOut);
          const w = cursor + i;
          if (w < dd.length) dd[w] += sd[r[0] + i] * g;
        }
      }
      cursor += len - fOut;
    }
    return out;
  }

  async function applyStructEdit() {
    const plan = state.structPlan;
    if (!state.originBuffer || !plan || !plan.length) return;
    if (!state.structDirty) {
      const st = $('#structState');
      if (st) st.textContent = '未改动';
      return;
    }
    const btn = $('#btnStructApply');
    if (btn) btn.disabled = true;
    const label = state.fileLabel || (state.profile && state.profile.meta.source_file) || '素材';
    const origDur = state.originBuffer.duration;
    try {
      const buf = spliceSegments(state.originBuffer, plan);
      if (!buf) throw new Error('splice 未产出音频');
      // 历史先入 state：runPipeline 内的 flushSave 会连它一起落库
      state.structHistory.push(plan.map((p) => ({ s: p.s, e: p.e, l: p.l })));
      await runPipeline(buf, `${label} · 结构改版`, state.loadGen, null, true);
      addVersionNode('结构改版',
        `${plan.length} 段 · ${origDur.toFixed(1)}s → ${buf.duration.toFixed(1)}s`);
      const st = $('#structState');
      if (st) {
        st.textContent =
          `已应用 · ${plan.length} 段 · ${origDur.toFixed(1)}s → ${buf.duration.toFixed(1)}s`;
      }
      setStatus(`结构已重排并重新体检 · ${origDur.toFixed(1)}s → ${buf.duration.toFixed(1)}s`, false);
      await flushSave();
    } catch (err) {
      console.error('[struct]', err);
      const st = $('#structState');
      if (st) st.textContent = '结构编辑失败';
      if (btn) btn.disabled = false;
    }
  }

  async function resetStructure() {
    if (!state.fileBuffer || !state.structHistory.length) return;
    const base = state.fileBuffer;
    const label = state.fileLabel || '整曲';
    const btn = $('#btnStructReset');
    if (btn) btn.disabled = true;
    try {
      state.structHistory = [];
      await runPipeline(base, label, state.loadGen, null, true);
      addVersionNode('结构还原', '回到导入时的整曲结构');
      const st = $('#structState');
      if (st) st.textContent = '已还原整曲';
      setStatus(`已还原整曲结构 · ${label}`, false);
      await flushSave();
    } catch (err) {
      console.error('[struct]', err);
      if (btn) btn.disabled = false;
    }
  }

  /* ---------- ⑤ 同旋律五调式互转试听 ---------- */
  async function auditionMelody() {
    const p = state.profile;
    const btn = $('#btnMelodyAudition');
    const tag = $('#melodyAuditionTag');
    if (ONCE.src && ONCE.btn === btn) {   // 播放中再点 = 停止，不必重新合成一遍
      stopOnce();
      if (tag) tag.textContent = '已停止试听';
      return;
    }
    if (!p || !p.melody || !p.melody.contour || !p.melody.contour.length) {
      if (tag) tag.textContent = '尚无旋律基因（体检后可用）';
      return;
    }
    const id = p.identity;
    const STEPS = [0, 2, 4, 7, 9];
    const MODE_DEG = { gong: 0, shang: 1, jue: 2, zhi: 3, yu: 4 };
    const rootIdx = E.PC_NAMES.indexOf(id.key);
    let gong = id.gongIndex;
    if (gong == null && rootIdx >= 0) {
      gong = ((rootIdx - STEPS[MODE_DEG[id.mode] ?? 0]) % 12 + 12) % 12;
    }
    if (gong == null || rootIdx < 0) {
      if (tag) tag.textContent = '主音未定，无法互转';
      return;
    }
    const deg = id.degIndex != null ? id.degIndex : (MODE_DEG[id.mode] ?? 0);
    const tgtIdx = modeIndexNow();
    const tgtMode = E.MODES[tgtIdx] || E.MODES[0];
    const remapped = E.transposeMelodyToMode(p.melody, gong, deg, tgtMode.degIndex);
    if (!remapped || !remapped.contour || !remapped.contour.length) {
      if (tag) tag.textContent = '旋律基因缺失';
      return;
    }
    const spf = 4096 / (p.meta.sampleRate || 44100);
    if (btn) btn.disabled = true;
    if (tag) tag.textContent = '合成中…';
    try {
      const buf = await E.renderMelodyPreview(
        remapped.contour, remapped.rhythm, spf, {});
      if (!buf) throw new Error('渲染为空');
      stopAll();  // 顺带停盲听；试听接管
      playOnce(buf, btn, '停止试听');
      if (tag) {
        const newTonic = E.PC_NAMES[(gong + STEPS[tgtMode.degIndex]) % 12];
        tag.textContent = tgtMode.degIndex === deg
          ? `${id.key}${id.modeGlyph} · 原样重放 ${remapped.contour.length} 音 · ${buf.duration.toFixed(1)}s`
          : `${id.key}${id.modeGlyph} → ${newTonic}${tgtMode.glyph} · ` +
            `${remapped.contour.length} 音 · ${buf.duration.toFixed(1)}s`;
      }
    } catch (err) {
      console.error('[melody]', err);
      if (tag) tag.textContent = '试听合成失败';
    }
    if (btn) btn.disabled = false;
  }

  /* ---------- ⑥ 有据可查的 AI（小米 MiMo · OpenAI 兼容接口） ---------- */
  const AI_LS = 'sonic.ai.cfg.v1';
  const AI_DEFAULTS = {
    baseUrl: 'https://api.xiaomimimo.com/v1',
    apiKey: '',
    model: 'mimo-v2.6-flash',
  };
  let aiCfg = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem(AI_LS) || 'null');
      const cfg = raw ? { ...AI_DEFAULTS, ...raw } : { ...AI_DEFAULTS };
      // mimo-v2.5 系列即将下架：本机已存的旧模型名自动迁移到 2.6 flash
      if (/^mimo-v2\.5/.test(cfg.model)) cfg.model = AI_DEFAULTS.model;
      return cfg;
    } catch (_) { return { ...AI_DEFAULTS }; }
  })();
  let aiMsgs = [];   // {role:'user'|'assistant', text} —— 只装成功往返
  let aiBusy = false;

  const AI_SYSTEM = [
    '你是「音智新媒 SonicPixel」工作台的分析助手，用户正在一首歌的体检页面里提问。',
    '铁律：',
    '1. 关于这首曲子的一切数值（BPM、拍号、调式、响度、结构、音质、版本等）只能来自对话里的【实测数据】，禁止编造或用训练记忆补全。',
    '2. 实测数据里没有的项，直接回答「实测数据中没有这一项」，不得给任何估计值。',
    '3. 引用本曲数值时标注字段路径（如 L1.bpm、质量.lra、响度.原曲_lufs）。',
    '4. 一般性的音乐理论可以正常回答，但必须与本曲实测分开表述，不得把一般结论说成本曲实测。',
    '5. 用中文，简洁直接。最后一行必须是引用行：〔引用：字段1, 字段2〕；纯概念回答写〔引用：无，概念性回答〕。',
  ].join('\n');

  function aiSyncUI() {
    const ready = !!aiCfg.apiKey;
    const inp = $('#aiInput');
    if (inp) {
      inp.disabled = !ready || aiBusy;
      inp.placeholder = ready ? '问问这首曲子的实测数据…' : '先在「接口设置」填入 API Key';
    }
    const send = $('#btnAiSend');
    if (send) send.disabled = !ready || aiBusy;
    const st = $('#aiState');
    if (st && !aiBusy) st.textContent = ready ? `${aiCfg.model} · 已配置` : '未配置 Key';
    const intro = $('#aiIntro');
    if (intro) {
      intro.textContent = ready
        ? '只引用本页 L1–L4 实测数据回答；涉及本曲的数值必须带字段出处，数据里没有的就直说没有。'
        : '未配置接口 Key：点右上角「接口设置」填入小米 MiMo 的 API Key 后可用。';
    }
  }

  function buildAiDossier() {
    const pre = $('#aiDossier');
    if (!pre) return;
    const p = state.profile;
    if (!p) { pre.textContent = '尚未体检'; return; }
    const id = p.identity, q = p.quality;
    const d = {
      素材: {
        文件: p.meta.source_file,
        时长_s: p.meta.duration,
        分析采样率: p.meta.sampleRate,
      },
      L1: {
        bpm: id.bpm,
        bpm_置信: id.bpmConfidence,
        拍号: id.meter,
        拍号_置信: id.meterConfidence,
        主音: id.key,
        调式: id.modeName,
        调式_置信: id.modeConfidence,
        五声符合: id.pentaFit,
        调性: id.westernKey,
        调性_置信: id.tonalityConfidence,
        宫音: id.gongKey,
      },
      质量: {
        残余比: residualRatio(q),
        lra_db: q.lra,
        crest_db: q.crest,
        频谱重心_hz: q.centroid,
        低频涂抹: q.mudSmear,
        哼声分: q.humScore,
        哼声频率: q.humFreq,
        哼声类型: q.humKind,
      },
      结构: (p.structure || []).map((s) => `${s.section} ${s.start.toFixed(0)}–${s.end.toFixed(0)}s`),
      旋律: p.melody ? {
        音符数: p.melody.noteCount,
        音域半音: p.melody.rangeSemitones,
        走向: p.melody.direction,
        调性清晰度: p.melody.tonalness,
      } : null,
      响度: state.lufs ? {
        原曲_lufs: state.lufs.orig ? state.lufs.orig.lufs : null,
        原曲_峰值_db: state.lufs.orig ? state.lufs.orig.peakDb : null,
        精修后_lufs: state.lufs.proc ? state.lufs.proc.lufs : null,
      } : null,
      精修: state.profileProcessed ? {
        残余比: residualRatio(state.profileProcessed.quality),
        lra_db: state.profileProcessed.quality.lra,
      } : '尚未精修',
      结构编辑: state.structHistory.length
        ? `已应用 ${state.structHistory.length} 次` : '无',
      导出响度目标: lufsTargetOf().label,
    };
    pre.textContent = JSON.stringify(d, null, 2);
  }

  function aiCites(text) {
    const chips = [];
    const re = /〔引用：([^〕]+)〕/g;
    let m;
    while ((m = re.exec(text))) {
      m[1].split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
        .forEach((s) => chips.push(s));
    }
    return chips;
  }

  function addAiBubble(text, isUser) {
    const log = $('#aiLog');
    const div = document.createElement('div');
    div.className = 'ai-bubble' + (isUser ? ' is-user' : '');
    const body = document.createElement('div');
    body.className = 'ai-text';
    body.textContent = text;
    div.appendChild(body);
    if (log) log.appendChild(div);
    return div;
  }

  function appendAiCites(bubble, text) {
    const chips = aiCites(text);
    if (!chips.length) return;
    const row = document.createElement('div');
    row.className = 'ai-cites';
    chips.forEach((c) => {
      const s = document.createElement('span');
      s.className = 'ai-cite';
      s.textContent = c;
      row.appendChild(s);
    });
    bubble.appendChild(row);
  }

  function renderAiLog() {
    const log = $('#aiLog');
    if (!log) return;
    log.innerHTML = '';
    aiMsgs.forEach((m) => addAiBubble(m.text, m.role === 'user'));
  }

  async function aiSend() {
    if (aiBusy) return;
    if (!aiCfg.apiKey) { openAiModal(); return; }
    const inp = $('#aiInput');
    const q = ((inp && inp.value) || '').trim();
    if (!q) return;

    buildAiDossier();
    const dossier = $('#aiDossier') ? $('#aiDossier').textContent : '';
    aiMsgs.push({ role: 'user', text: q });
    renderAiLog();
    if (inp) inp.value = '';
    aiBusy = true;
    aiSyncUI();
    const st = $('#aiState');
    if (st) st.textContent = '生成中…';

    const log = $('#aiLog');
    const bubble = addAiBubble('', false);
    const body = bubble.querySelector('.ai-text');
    if (log) log.scrollTop = log.scrollHeight;
    const history = aiMsgs.slice(0, -1).slice(-8)
      .map((m) => ({ role: m.role, content: m.text }));
    // 消息打包契约（verify-innovations 有断言锁着）：
    // · system = 只有 AI_SYSTEM 那五条引用铁律，绝不混入卷宗——
    //   数据块一旦进 system，「答案只能来自实测」的规则会被稀释
    // · 卷宗只垫在「本轮」user 消息里，历史轮次发纯问答，不重发全量数据
    // · system 规则 → 卷宗 → 问题，模型按这个顺序读
    const messages = [
      { role: 'system', content: AI_SYSTEM },
      ...history,
      { role: 'user', content: `【实测数据】\n${dossier}\n\n【问题】${q}` },
    ];

    let text = '';
    // finally 里的 aiSyncUI 会把状态条刷回「已配置」，
    // 成功/失败的落点要在它之后再写一次
    let finalMsg = null;
    try {
      const res = await fetch(
        aiCfg.baseUrl.replace(/\/+$/, '') + '/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + aiCfg.apiKey,
          },
          body: JSON.stringify({ model: aiCfg.model, messages, stream: true }),
        }
      );
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try {
          const j = await res.json();
          msg = (j.error && j.error.message) || msg;
        } catch (_) {}
        throw new Error(msg);
      }
      // SSE：data: {...} 行流，data: [DONE] 收尾
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let pending = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += dec.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const delta = j.choices && j.choices[0] &&
              j.choices[0].delta && j.choices[0].delta.content;
            if (delta) {
              text += delta;
              body.textContent = text;
              if (log) log.scrollTop = log.scrollHeight;
            }
          } catch (_) { /* 半行 JSON，等下一批拼上 */ }
        }
      }
      if (!text) throw new Error('接口没有返回内容');
      aiMsgs.push({ role: 'assistant', text });
      appendAiCites(bubble, text);
      finalMsg = '已回答 · 引用实测数据';
    } catch (err) {
      console.error('[ai]', err);
      body.textContent = '请求失败：' + (err && err.message ? err.message : String(err));
      bubble.classList.add('is-error');
      finalMsg = '失败：' + (err && err.message ? err.message : '未知错误');
    } finally {
      aiBusy = false;
      aiSyncUI();
      if (finalMsg) $('#aiState').textContent = finalMsg;
    }
  }

  function openAiModal() {
    const m = $('#aiModal');
    if (!m) return;
    const base = $('#aiBaseUrl');
    const key = $('#aiKey');
    const model = $('#aiModel');
    if (base) base.value = aiCfg.baseUrl;
    if (key) key.value = aiCfg.apiKey;
    if (model) model.value = aiCfg.model;
    const tag = $('#aiTestTag');
    if (tag) tag.textContent = aiCfg.apiKey ? '已保存 Key' : '未配置';
    m.hidden = false;
    if (key) key.focus();
  }

  function closeAiModal() {
    const m = $('#aiModal');
    if (m) m.hidden = true;
  }

  function saveAiModal() {
    const base = $('#aiBaseUrl');
    const key = $('#aiKey');
    const model = $('#aiModel');
    aiCfg = {
      baseUrl: ((base && base.value) || AI_DEFAULTS.baseUrl).trim().replace(/\/+$/, ''),
      apiKey: (key && key.value || '').trim(),
      model: ((model && model.value) || AI_DEFAULTS.model).trim(),
    };
    try { localStorage.setItem(AI_LS, JSON.stringify(aiCfg)); } catch (_) {}
    aiSyncUI();
    const tag = $('#aiTestTag');
    if (tag) tag.textContent = aiCfg.apiKey ? '已保存' : '未填 Key';
  }

  async function testAiConn() {
    const tag = $('#aiTestTag');
    saveAiModal();
    if (!aiCfg.apiKey) {
      if (tag) tag.textContent = '先填 Key';
      return;
    }
    if (tag) tag.textContent = '连接中…';
    try {
      const res = await fetch(aiCfg.baseUrl + '/models', {
        headers: { Authorization: 'Bearer ' + aiCfg.apiKey },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const n = Array.isArray(j.data) ? j.data.length : null;
      if (tag) tag.textContent = n != null ? `连接正常 · ${n} 个模型` : '连接正常';
    } catch (err) {
      if (tag) tag.textContent = '失败：' + (err && err.message ? err.message : String(err));
    }
  }

  /* ============================================================
     L2 素材类型（分治开关）
     ------------------------------------------------------------
     两条链解决的是两组不同的毛病，所以这是一个由用户拍板的选项，
     不做自动分诊：L1 能测出「有没有哼声」，但测不出「这歌是生成的还是
     录的」——AI 素材一样能带 50/60Hz，猜错了会跑错整条链。
     ============================================================ */
  const KINDS = [
    { id: 'ai', label: 'AI 生成音乐' },
    { id: 'acoustic', label: '真实录音' },
  ];

  function buildSourceKind() {
    const wrap = $('#sourceKind');
    if (!wrap) return;
    wrap.innerHTML = '';
    KINDS.forEach((k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (k.id === state.material ? ' is-active' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', k.id === state.material ? 'true' : 'false');
      b.dataset.kind = k.id;
      b.textContent = k.label;
      b.addEventListener('click', () => {
        if (state.material === k.id) return;
        state.material = k.id;
        buildSourceKind();
        // 换链 = 换处方。EQ 预置跟着重算，手动调过的值会被覆盖，
        // 所以必须明说，不能默默把用户的调整吃掉。
        if (state.profile) {
          // preserveEq=true：EQ 预置跟素材类型无关，换链只重排处方文案。
          // 用户手动拖过的曲线必须原样留住（旧版这里无条件 syncEqBands，
          // 把「已手动调整」打回预置，等于静默吃掉用户的调整）。
          buildPrescription(state.profile, true);
        }
        setStatus(
          state.processedBuffer
            ? '素材类型已改为「' + k.label + '」，处方已按新链重算' +
              (state.eqManual ? '，手动 EQ 保留' : '') + '，请重新执行精修。'
            : '素材类型已改为「' + k.label + '」，处方已按新链重算' +
              (state.eqManual ? '，手动 EQ 保留' : '') + '。',
          false
        );
        scheduleSave();
      });
      wrap.appendChild(b);
    });
    updateKindHint();
  }

  /* 提示里写实测数字，不写空话：当前选中的链要干什么、
     以及 L1 在这首歌上到底测出了什么。 */
  function updateKindHint() {
    const el = $('#kindHint');
    if (!el) return;
    const q = state.profile && state.profile.quality;
    const hum = q && q.humScore != null ? q.humScore : 0;
    const hz = (q && q.humFreq) || 0;
    const tail = (hum > 0.2 && hz)
      ? `L1 实测 ${hz}Hz 窄带突出度 ${((q.humProminence != null ? q.humProminence : 0)).toFixed(0)}×，两条链都会下陷波。`
      : 'L1 未检出工频哼声，不加陷波。';
    el.textContent = (state.material === 'acoustic'
      ? '修复链：压缩 + 噪声门，针对连续底噪、电网哼声与房间共鸣。'
      : '还原链：不压缩，改用向上扩展找回被压扁的起伏，噪声门只做极轻收口。')
      + tail;
  }

  /* preserveEq：只重排处方文案与策略标签，不碰 EQ。
     换素材类型时用手动值保护 —— EQ 预置本身跟素材类型无关
     （见下方 eq 计算），硬刷一遍只会把用户拖好的曲线抹掉。 */
  function buildPrescription(profile, preserveEq) {
    const q = profile.quality;
    const lines = [];

    if (q.subRatio > 0.02 || q.lowRatio > 0.28) {
      lines.push(['前置滤波',
        `切除 30Hz 以下超低频。当前低频能量占比 ${(q.lowRatio * 100).toFixed(0)}%，` +
        `超低频 ${(q.subRatio * 100).toFixed(1)}%，已挤占动态余量。`]);
    } else {
      lines.push(['前置滤波',
        '底噪较干净，保留 30Hz 高通作为安全边界，不做进一步削减。']);
    }

    // 低频缺陷分 = max(谐波间涂抹, 工频哼声)。两者成因不同，处方分开说：
    // 哼声是窄带纯音要下陷波，涂抹是泛音列之间摊开的能量要压中低频。
    // 不能都叫「浑浊度」——红头绳实测 mudScore 0.009，旧的「150–400Hz
    // 占比 ×2.6」会给 57%，那测的是音色明暗不是缺陷。
    const smear = q.mudSmear != null ? q.mudSmear : null;
    const hum = q.humScore != null ? q.humScore : 0;
    const humHz = q.humFreq || 0;
    const humProm = q.humProminence != null ? q.humProminence : 0;
    // 分诊由引擎的 humKind 给出，名字不能叫错：
    // mains=工频哼声（50/60Hz 电网）；ripple=整流纹波（100/120Hz 二次谐波，
    // 基频常被滤掉）；narrowband=窄带低频峰（示例曲那根 35Hz 的隆隆声）。
    // 三者一样下陷波，但成因不同，处方措辞必须分开。
    const humKindLabel = q.humKind === 'ripple' ? '整流纹波'
      : q.humKind === 'mains' ? '工频哼声' : '窄带低频峰';
    if (hum > 0.2) {
      const extra = q.humKind === 'ripple'
        ? '整流纹波是电网频率的二次谐波，基频常已被滤掉，陷波同时沿 1/2 倍频核对。'
        : '沿 2/3 次谐波轻压。';
      lines.push(['动态均衡',
        `检测到约 ${humHz}Hz ${humKindLabel}（窄带突出度 ${humProm.toFixed(0)}×），` +
        `在 ${humHz}Hz 下窄带陷波，并${extra}`]);
    } else if (smear != null && smear > 0.25) {
      lines.push(['动态均衡',
        `150–400Hz 谐波间涂抹 ${(smear * 100).toFixed(0)}% 偏高（能量摊到泛音列之外），` +
        '压低中低频并轻抬低频紧实度。']);
    } else if (q.lowRatio > 0.2) {
      lines.push(['动态均衡',
        '低频有量但松散，围绕 90Hz 做窄带梳理，保持整体平衡。']);
    } else {
      lines.push(['动态均衡',
        '低频干净：150–400Hz 能量压在泛音列上，未检出工频哼声。均衡段按当前曲线维持。']);
    }

    // 语义：residual 是「谐波外残余能量比」（掩蔽谐波结构后的残余能量占比），
    // 不是 THD，看不出过载谐波——不得按谐波失真诊断，更不能写「过载谐波」。
    const residual = residualRatio(q);
    const cov = coverageOf(q);
    if (residual == null) {
      lines.push(['谐波优化',
        '谐波结构不足，未能估计谐波外残余能量比，跳过该处方。']);
    } else if (cov != null && cov <= 0.6) {
      lines.push(['谐波优化',
        `本曲帧内谐波结构可辨度不足（覆盖率 ${Math.round(cov * 100)}%），` +
        '谐波外残余能量比不具诊断意义，本段不做谐波类处理。']);
    } else if (residual > 0.15) {
      lines.push(['谐波优化',
        `谐波外残余能量比 ${(residual * 100).toFixed(1)}% 偏高，` +
        '非谐波成分（噪底/瞬态/空间残响）偏多，以去噪与瞬态塑形为主，不做谐波削减。']);
    } else {
      lines.push(['谐波优化',
        `谐波外残余能量比 ${(residual * 100).toFixed(1)}% 处于正常区间，` +
        '维持现有谐波结构，适度激励提升质感（激励只作用于中高，低频直通）。']);
    }

    /* 分治在这里落到文案上。引擎那侧已经按素材类型换了链
       （录音 = 压缩 + 深门，AI = 向上扩展 + 轻门），处方必须说同一件事，
       否则用户读到的说明和实际跑的算法对不上。 */
    const acoustic = state.material === 'acoustic';
    const lra = q.lra || 0;
    if (acoustic) {
      lines.push(['底噪与动态',
        `录音链：挂压缩器压住现场动态，噪声门收连续底噪` +
        (hum > 0.2
          ? `，并在 ${humHz}Hz 下陷波，沿 2/3 次谐波各补一刀。`
          : '，未检出工频哼声，不加陷波。')]);
      if (lra > 14) {
        lines.push(['动态控制',
          `动态范围 ${lra.toFixed(1)} dB 偏大，压缩使整体更统一。`]);
      }
    } else {
      const ex = expandOf(q);
      lines.push(['动态还原',
        `生成链：不压缩——响度目标已经把起伏压过一轮，再压只会更平。` +
        `改用向上扩展，按实测 LRA ${lra.toFixed(1)} dB 给到 ${Math.round(ex * 100)}% 扩展量` +
        `（上限 ±5 dB）；噪声门只做极轻收口，不啃合成素材的淡出。` +
        (hum > 0.2 ? `${humHz}Hz 哼声照常下陷波——哼声是测出来的，跟素材类别无关。` : '')]);
    }

    const ul = $('#prescription');
    ul.innerHTML = '';
    lines.forEach(([tag, text], i) => {
      const li = document.createElement('li');
      li.className = 'prescription-item';
      li.innerHTML =
        `<span class="prescription-step">${i + 1}</span>` +
        `<div><b>${tag}</b><p>${text}</p></div>`;
      ul.appendChild(li);
      setTimeout(() => li.classList.add('is-in'), 90 * i + 40);
    });

    // EQ 预置：哼声走陷波，涂抹走中低频削减，两件事分开做。
    // 哼声最后压：低频抬升会把它盖掉，陷波必须赢。
    if (!preserveEq) {
      const eq = new Array(10).fill(0);
      if (smear != null && smear > 0.25) { eq[3] = -0.45; eq[4] = -0.3; }
      if (q.lowRatio > 0.2 && hum <= 0.2) { eq[1] = 0.32; eq[2] = 0.18; }
      if (hum > 0.2) { eq[0] = -0.55; eq[1] = -0.35; }
      // 频谱重心在 profile.timbre.centroid（quality 里没有 centroid 字段）；
      // cent > 0 守卫：无有效频谱帧时 centroid 为 0，不能误判成「过暗」去抬 4k/8k
      const cent = profile.timbre && profile.timbre.centroid;
      if (cent > 3200) eq[8] = -0.15;
      if (cent > 0 && cent < 1400) { eq[7] = 0.22; eq[8] = 0.18; }
      state.eqParams = eq;
      state.eqManual = false;
    }

    // 处理策略：只写引擎真在做的事。
    // 旧版写着「古风 · 无损模式 / 线性相位」，但引擎里既没有无损模式，
    // 也没有线性相位滤波器——EQ 用的全是 Biquad，那就是最小相位。
    const chips = $('#styleModeChips');
    chips.innerHTML = '';
    [
      ['处理链', acoustic ? '录音 · 修复链' : 'AI · 还原链'],
      ['作用对象', acoustic ? '底噪、工频哼声与房间共鸣' : '响度压扁的动态与低频堆叠'],
      ['滤波相位', '最小相位（双二阶）'],
    ].forEach(([k, v]) => {
      const el = document.createElement('span');
      el.className = 'chip';
      el.innerHTML = `${k}　${v}`;
      chips.appendChild(el);
    });
  }

  function buildEqBands() {
    const wrap = $('#eqBands');
    if (wrap.children.length) return;
    const freqs = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
    freqs.forEach((f, i) => {
      const band = document.createElement('div');
      band.className = 'eq-band';
      band.innerHTML =
        `<span class="eq-band-label">${f}</span>` +
        `<input class="eq-slider" type="range" min="-100" max="100" value="0" data-i="${i}" aria-label="${f}Hz" />` +
        `<span class="eq-band-val">0</span>`;
      wrap.appendChild(band);

      const inp = band.querySelector('input');
      const val = band.querySelector('.eq-band-val');
      inp.addEventListener('input', () => {
        const g = Number(inp.value) / 100;
        state.eqParams[i] = g;
        val.textContent = (g > 0 ? '+' : '') + (g * 12).toFixed(1);
        band.classList.toggle('is-scale', Math.abs(g) > 0.08);
        drawEqCurve($('#chartEq'), state.eqParams);
        $('#eqTag').textContent = '已手动调整';
        state.eqManual = true;
      });
    });
  }

  function syncEqBands() {
    const eq = state.eqParams;
    $$('.eq-band').forEach((band, i) => {
      const g = eq[i] || 0;
      band.querySelector('input').value = Math.round(g * 100);
      band.querySelector('.eq-band-val').textContent = (g > 0 ? '+' : '') + (g * 12).toFixed(1);
      band.classList.toggle('is-scale', Math.abs(g) > 0.08);
    });
    drawEqCurve($('#chartEq'), eq);
    $('#eqTag').textContent = '按处方预置';
  }

  /* ============================================================
     五轨
     ============================================================ */
  function renderTracks(events) {
    const wrap = $('#tracks');
    wrap.innerHTML = '';
    const defs = [
      { id: 'lead',  name: '主旋', note: '五声音阶乐句' },
      { id: 'harm',  name: '和声', note: '调式内三度叠置' },
      { id: 'bass',  name: '贝斯', note: '根音支撑' },
      { id: 'drums', name: '鼓组', note: '节拍骨架' },
      { id: 'pad',   name: '氛围', note: '空间垫底' },
    ];

    defs.forEach((t) => {
      const evs = events ? events.filter((e) => e.track === t.id) : [];
      const el = document.createElement('div');
      el.className = 'track';
      el.dataset.track = t.id;

      // 乐句色块：按时间轴绝对定位，宽度 = 时值
      let notesHtml = '';
      if (evs.length) {
        const tMax = Math.max(...events.map((e) => e.t + e.dur)) || 1;
        notesHtml = evs.slice(0, 64).map((e) => {
          const left = (e.t / tMax) * 100;
          const w = Math.max(0.9, (e.dur / tMax) * 100);
          return `<i class="track-note" style="left:${left}%;width:${w}%;background:${TRACK_COLORS[t.id]}"></i>`;
        }).join('');
      }

      el.innerHTML =
        `<div class="track-name">` +
          `<i class="track-dot" style="background:${TRACK_COLORS[t.id]}"></i>${t.name}` +
        `</div>` +
        `<div class="track-lane"><div class="track-notes">${notesHtml}</div></div>` +
        `<button class="track-btn" aria-pressed="false">静音</button>`;

      const btn = el.querySelector('.track-btn');
      // 静音态持久化在 state.muted：轨道列表重建后仍要恢复按钮外观，
      // 渲染/导出也一律以 state.muted 为准（DOM class 只是显示）
      const applyMuteUI = (on) => {
        el.classList.toggle('is-muted', on);
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.textContent = on ? '已静音' : '静音';
      };
      applyMuteUI(!!state.muted[t.id]);
      btn.addEventListener('click', () => {
        const on = !state.muted[t.id];
        state.muted[t.id] = on;
        applyMuteUI(on);
        // 播放的是渲染时混好的 buffer，静音须重新渲染后才对播放/导出生效
        markArrangementStale();
        if (state.arrangement) {
          setStatus(`${t.name}${on ? '已静音' : '已取消静音'}，播放/导出前请重新渲染乐段`, false);
        }
      });

      // 小字说明
      const sub = document.createElement('div');
      sub.className = 'metric-sub';
      sub.style.gridColumn = '1 / -1';
      sub.style.marginTop = '-6px';
      sub.textContent = `${t.note}　·　${evs.length} 个音符`;
      el.appendChild(sub);

      wrap.appendChild(el);
    });
  }

  /* ============================================================
     版本树
     ============================================================ */
  function addVersionNode(title, meta) {
    state.versionTree.push({ title, meta });
    renderTree();
  }

  function resetVersionTree() {
    state.versionTree = [];
    renderTree();
  }

  function renderTree() {
    const root = $('#tree');
    const empty = $('#treeEmpty');
    if (!state.versionTree.length) {
      root.textContent = '';
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    root.textContent = '';
    const nodes = [{ title: 'origin', meta: '导入的原始音频', tag: '源头' },
      ...state.versionTree.map((n, i) => ({
        title: n.title, meta: n.meta, tag: 'v' + (i + 1),
      }))];

    // 连接符由 CSS 的 .tree-node:not(:last-child)::after 画，这里不再插节点
    nodes.forEach((n, i) => {
      const el = document.createElement('div');
      el.className = 'tree-node' + (i === nodes.length - 1 ? ' is-current' : '');
      const tag = document.createElement('div');
      tag.className = 'tree-tag';
      tag.textContent = n.tag;
      const label = document.createElement('div');
      label.className = 'tree-label';
      label.textContent = n.title;
      const meta = document.createElement('div');
      meta.className = 'tree-meta';
      meta.textContent = n.meta;
      el.append(tag, label, meta);
      root.appendChild(el);
    });
  }

  /* ============================================================
     播放 · 轻量走带
     一条 BufferSource + 起点偏移就够暂停 / 续播 / 跳转，
     不做任何实时处理。旧的 playBuffer 只会「从头放一遍」，
     没有暂停也没有进度 —— 导入完连听都听不了。
     ============================================================ */
  const T = {
    src: null, buffer: null,
    startedAt: 0,      // AudioContext.currentTime 起播瞬间
    offset: 0,         // 已播到的秒数（暂停/跳转后作为续播起点）
    playing: false,
    raf: 0,
  };

  function stopAll() {
    stopBlind();          // 盲听是另一路声源：走带一动它必须让位
    stopOnce();           // 一次性试听（乐段/旋律互转）同理，否则两路叠着响
    if (T.src) {
      try { T.src.onended = null; T.src.stop(0); } catch (_) {}
      T.src = null;
    }
    if (T.raf) { cancelAnimationFrame(T.raf); T.raf = 0; }
    T.playing = false;
    state.playNodes = [];
    syncTransportUI();
  }

  /* 当前播放头位置（秒） */
  function tPos() {
    if (!T.buffer) return 0;
    const p = T.playing
      ? T.offset + (getCtx().currentTime - T.startedAt)
      : T.offset;
    return Math.max(0, Math.min(p, T.buffer.duration));
  }

  /* 播放。buffer 换了就从头，否则从 offset 续播；fromSec 显式跳转 */
  function playBuffer(buffer, btn, fromSec) {
    const ctx = getCtx();
    // 无条件 resume：有的浏览器 context 报 running 但渲染线程还没起来
    ctx.resume?.();
    if (buffer && buffer !== T.buffer) {
      stopAll();
      T.buffer = buffer;
      T.offset = 0;
    }
    if (!T.buffer) return;
    if (typeof fromSec === 'number') {
      // 显式起点按字面执行（跳转 / 点波形），到尾就是到尾
      T.offset = Math.max(0, Math.min(fromSec, T.buffer.duration));
    } else if (T.offset >= T.buffer.duration - 0.02) {
      // 不带起点续播且已到头 → 从头再来，避免点了没反应
      T.offset = 0;
    }

    stopOnce();   // 走带一开，一次性试听必须闭嘴，否则两路叠响
    if (T.src) { try { T.src.onended = null; T.src.stop(0); } catch (_) {} }
    if (T.raf) { cancelAnimationFrame(T.raf); T.raf = 0; }

    const src = ctx.createBufferSource();
    src.buffer = T.buffer;
    src.connect(ctx.destination);
    src.start(0, T.offset);
    T.src = src;
    T.startedAt = ctx.currentTime;
    T.playing = true;
    state.playNodes = [src];

    src.onended = () => {
      if (T.src !== src) return;
      T.src = null; T.playing = false; T.offset = 0;
      if (T.raf) { cancelAnimationFrame(T.raf); T.raf = 0; }
      syncTransportUI();
    };
    if (btn) btn.setAttribute('data-playing', '1');
    syncTransportUI();
    const tick = () => {
      if (!T.playing) return;
      syncTransportUI();
      T.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  function pauseBuffer() {
    if (!T.playing) return;
    T.offset = tPos();
    stopAll();
  }

  /* 播放/暂停切换：有音源就接着放，没有就播当前展示的那条 */
  function togglePlay() {
    if (T.playing) { pauseBuffer(); return; }
    const buf = state.showingAfter && state.processedBuffer
      ? state.processedBuffer
      : (state.processedBuffer || state.originBuffer);
    // 不传 fromSec：沿用 T.offset，到头由 playBuffer 自动回开头
    if (buf) playBuffer(buf, null);
    else setStatus('请先导入音频。', false);
  }

  function seekTo(sec) {
    if (!T.buffer) return;
    const was = T.playing;
    T.offset = Math.max(0, Math.min(sec, T.buffer.duration));
    if (was) playBuffer(T.buffer, null, T.offset);
    else syncTransportUI();
  }

  /* 一次性播放（L3 编曲试听 / 旋律互转试听）：不接管波形走带，
     否则编曲的时长会盖到波形进度条上，把「原曲」和「乐段」搅在一起。
     播放中把按钮换成停止键——再点同一按钮即停；没有这一下，
     试听响完之前用户只能干等，走带也停不掉它。 */
  const ONCE = { src: null, btn: null, old: '' };

  function clearOnce() {
    ONCE.src = null;
    if (ONCE.btn) {
      ONCE.btn.textContent = ONCE.old;
      ONCE.btn = null;
      ONCE.old = '';
    }
  }

  function stopOnce() {
    const s = ONCE.src;
    clearOnce();
    if (s) { try { s.onended = null; s.stop(0); } catch (_) {} }
  }

  function playOnce(buffer, btn, stopLabel) {
    if (!buffer) return;
    if (btn && ONCE.src && ONCE.btn === btn) { stopOnce(); return; } // 播放中再点 = 停止
    const ctx = getCtx();
    ctx.resume?.();
    stopAll();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0);
    state.playNodes.push(src);
    if (btn) {
      ONCE.src = src;
      ONCE.btn = btn;
      ONCE.old = btn.textContent;
      btn.textContent = stopLabel || '停止';
    }
    src.onended = () => { if (ONCE.src === src) clearOnce(); };
  }

  /* 走带 UI 三处同步：试听按钮 / 波形播放键 / 进度条 */
  function syncTransportUI() {
    const pos = tPos();
    const dur = T.buffer ? T.buffer.duration : 0;
    const label = T.playing ? '暂停' : '试听';
    const listen = $('#btnListen');
    if (listen) {
      listen.textContent = T.playing ? '暂停' : (dur ? '试听' : '试听');
      listen.setAttribute('aria-pressed', T.playing ? 'true' : 'false');
    }
    const waveBtn = $('#btnWavePlay');
    if (waveBtn) {
      waveBtn.textContent = T.playing ? '暂停' : '播放';
      waveBtn.setAttribute('aria-pressed', T.playing ? 'true' : 'false');
    }
    const fill = $('#wavePlayFill');
    if (fill) fill.style.width = dur ? (pos / dur) * 100 + '%' : '0%';
    const bar = $('#wavePlayBar');
    if (bar) {
      bar.setAttribute('aria-valuemax', dur ? String(Math.round(dur * 10)) : '100');
      bar.setAttribute('aria-valuenow', String(Math.round(pos * 10)));
      bar.setAttribute('aria-valuetext', fmtTime(pos) + ' / ' + fmtTime(dur));
    }
    const cur = $('#wavePlayCur');
    if (cur) cur.textContent = fmtTime(pos);
    const tot = $('#wavePlayDur');
    if (tot) tot.textContent = fmtTime(dur);
    const note = $('#listenTag');
    if (note) {
      note.textContent = !dur ? '导入后即可试听原曲'
        : T.playing ? '正在播放 · 点波形任意位置可跳转'
        : '已暂停 · 点波形任意位置可跳转';
    }
  }

  function setStatus(text, live) {
    $('#heroStatusText').textContent = text;
    $('#heroStatus').classList.toggle('is-live', !!live);
    $('#dropStatus').textContent = text;
  }

  /* 波形视图统一入口：画布 / chip 选中态 / 图注三方同步 */
  function setWaveView(showingAfter, noteText) {
    const after = !!showingAfter && !!state.processedBuffer; // 无精修产物时强制回 before
    state.showingAfter = after;
    drawWave($('#chartWave'), after ? state.processedBuffer : state.originBuffer,
      after ? C.terracotta : C.clay);
    $$('.chip[data-wave]').forEach((c) => {
      const active = c.dataset.wave === (after ? 'after' : 'before');
      c.classList.toggle('is-active', active);
      c.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const note = $('#waveNote');
    if (note) {
      note.textContent = noteText || (after
        ? '当前显示精修后波形'
        : (state.processedBuffer ? '当前显示原始波形' : '尚未精修，显示原始波形'));
    }
    // 走带跟着视图走：换波形就换音源，播放头位置不动 → 这才是 A/B 对照听
    const buf = after ? state.processedBuffer : state.originBuffer;
    if (buf && T.buffer !== buf) {
      const pos = tPos();
      const was = T.playing;
      if (was) playBuffer(buf, null, pos);
      else { T.buffer = buf; T.offset = Math.min(pos, buf.duration || 0); }
    }
    syncTransportUI();
  }

  /* 参数（调式/BPM/小节/静音）改过之后，已渲染编曲即过期：
     播放/导出前必须重新渲染，否则用户会把旧参数的音频当新参数的结果交付 */
  function markArrangementStale() {
    const a = state.arrangement;
    if (!a || a.stale) return;
    a.stale = true;
    const btn = $('#btnRender');
    if (btn) btn.textContent = '参数已修改 · 重新渲染';
  }

  /* ============================================================
     L1 流水线
     ============================================================ */
  function resetDerivedUI() {
    // 换素材时把精修 / 再生 / 回流的界面一并归位，避免残留上一首的数字
    const btnAB = $('#btnAB');
    if (btnAB) btnAB.disabled = true;
    const btnExpProc = $('#btnExportProcessed');
    if (btnExpProc) btnExpProc.disabled = true;
    const btnProcess = $('#btnProcess');
    if (btnProcess) { btnProcess.disabled = false; btnProcess.textContent = '执行精修'; }
    const btnRender = $('#btnRender');
    if (btnRender) { btnRender.disabled = false; btnRender.textContent = '渲染乐段'; }
    const meterOut = $('#meterOut');
    if (meterOut) { meterOut.textContent = '—'; meterOut.title = ''; }
    setWaveView(false);

    const tracks = $('#tracks');
    if (tracks) tracks.textContent = '';
    const piano = $('#chartPiano');
    if (piano) {
      const g = piano.getContext('2d');
      if (g) g.clearRect(0, 0, piano.width, piano.height);
    }

    $$('.check').forEach((el) => {
      el.className = 'check';
      const v = el.querySelector('.check-value');
      if (v) v.textContent = '待执行';
      const p = el.querySelector('p');
      if (p) p.textContent = '完成精修或再生后执行，核对派生产物是否守住原作骨架。';
    });

    // 盲听 / AI 的状态条跟着归位（按钮归位由 stopAll→stopBlind 负责，这里是幂等兜底）
    blindUIInit();
    aiSyncUI();
  }

  // cached：工作区恢复时带上存盘的 L1 结果。同一个 buffer 的 analyze 是确定性的，
  // 重算要 1.95s（4 分钟素材实测）且结果与存盘一致，直接用存的那次。
  // keepFile：结构编辑 / 还原整曲的重跑——这次的输入不是新的源素材，
  // fileBuffer、结构历史、AI 对话都得原样保留。
  async function runPipeline(buffer, label, gen, cached, keepFile) {
    setStatus('正在体检…', true);
    await new Promise((r) => setTimeout(r, 30));
    // 期间用户又导入了别的素材：丢弃这份过期分析，不写任何 state/DOM
    if (gen != null && gen !== state.loadGen) return;

    // 换素材就清空上一版的精修产物，避免 A/B 播到旧音频、版本树串台
    stopAll();
    T.buffer = null;
    T.offset = 0;
    state.processedBuffer = null;
    state.profileProcessed = null;
    state.profileArrangement = null;
    state.arrangement = null;
    state.showingAfter = false;
    state.eqParams = null;
    state.muted = {};
    resetVersionTree();
    resetDerivedUI();

    if (!keepFile) {
      // 结构编辑的还原原点：只有「真·新素材」才换掉它
      state.fileBuffer = buffer;
      state.fileLabel = label;
      state.structHistory = [];
      aiMsgs = [];
      renderAiLog();
    }

    const profile = (cached && cached.meta ? cached : E.analyze(buffer));
    profile.meta.source_file = label;
    state.originBuffer = buffer;
    state.profile = profile;
    // 整曲响度实测（BS.1770）：L1 指标与证据链共用这一次测量
    state.lufs = { orig: E.measureLoudness(buffer), proc: null };
    // 走带挂上新素材，试听立刻可用（不必先精修）
    T.buffer = buffer;
    T.offset = 0;
    syncTransportUI();
    const btnExportProfile = $('#btnExportProfile');
    if (btnExportProfile) btnExportProfile.disabled = false;

    $('#checkEmpty').hidden = true;
    $('#checkBody').hidden = false;
    renderModeDial(profile);
    renderMetrics(profile);
    drawSpectrum($('#chartSpectrum'), profile.quality.spectrum, profile.meta.sampleRate);
    drawStructure($('#chartStructure'), profile.structure, profile.meta.duration);
    renderStructureLegend(profile.structure);
    // 第一梯队创新的仪表盘：证据链、结构计划、响度目标、AI 卷宗
    ensureEvidence(profile);
    buildEvidenceUI();
    renderScoreCard(profile);   // 原曲五线谱：与证据链并列的独立卡片
    updateLoudCurve('all');     // 响度走势：原曲曲线（精修产物已在此前清空）
    buildStructPlan();
    buildLufsTargets();
    buildAiDossier();

    const tonalTag = profile.identity.tonalityName
      ? ` · ${profile.identity.westernKey || profile.identity.tonalityName}` : '';
    setStatus(
      `体检完成 · ${label} · ` +
      `${profile.identity.bpm ? profile.identity.bpm.toFixed(1) : '—'} BPM · ` +
      `${profile.identity.key} ${profile.identity.modeName}${tonalTag}`, false
    );

    $('#refineEmpty').hidden = true;
    $('#refineBody').hidden = false;
    // 换素材就得重算：陷波频率不能把上一首的 51Hz 带到下一首，
    // 素材类型回到默认（恢复工作区时 restoreWorkspace 再改回存盘值）
    state.notches = notchesOf(profile.quality);
    state.material = 'ai';
    buildSourceKind();
    buildPrescription(profile);
    buildEqBands();
    syncEqBands();
    setWaveView(false);
    // L3 调式选择器跟随体检检出的调式重建
    buildModeSelect();

    addVersionNode('导入体检', `${label} · ${profile.identity.key} ${profile.identity.modeName}`);
    await flushSave();

    // 新出现的卡片需要补触发 reveal
    setTimeout(() => {
      $$('#checkBody .reveal, #refineBody .reveal').forEach((el) => el.classList.add('is-in'));
      $('#sec-check').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 200);
  }

  /* ============================================================
     L2 精修
     ============================================================ */
  // cache：恢复工作区时带上存盘的 L2 结果。源字节与参数都没变，
  // process() 输出确定，但同尺寸 analyze 要 ~1.95s，用存的那次。
  async function processAudio(cache) {
    if (!state.originBuffer) return;
    const btn = $('#btnProcess');
    btn.disabled = true;
    btn.textContent = '处理中…';
    const strength = Number($('#strength').value) / 100;

    try {
      const out = await E.process(state.originBuffer, {
        highpass: 30,
        eq: state.eqParams,
        exciter: 0.3,
        denoise: 0.25,
        threshold: 0.35,
        ratio: 0.32,
        intensity: strength,
        // 分治三件套：走哪条链、砍哪些窄带峰、动态还原给多少
        kind: state.material,
        notches: state.notches,
        expand: expandOf(state.profile && state.profile.quality),
      });
      state.processedBuffer = out;
      const cachedP = cache && cache.profileProcessed && cache.profileProcessed.meta
        ? cache.profileProcessed : null;
      state.profileProcessed = cachedP || E.analyze(out);
      state.profileProcessed.meta.source_file = state.profile?.meta?.source_file || null;

      // 指标是「谐波外残余能量比」不是 THD；未测出显示 '—'，不编数字
      const pq = state.profileProcessed.quality;
      const resid = residualRatio(pq);
      const lra = pq.lra;
      const metricNote =
        `精修完成 · 残余 ${resid != null ? (resid * 100).toFixed(1) + '%' : '—'} · ` +
        `LRA ${lra != null ? lra.toFixed(1) + ' dB' : '—'}`;
      setWaveView(true, metricNote);

      addVersionNode('精修',
        `三级处理链 · 强度 ${Math.round(strength * 100)}% · ` +
        `残余 ${resid != null ? (resid * 100).toFixed(1) + '%' : '—'}`);

      $('#btnAB').disabled = false;
      const btnExp = $('#btnExportProcessed');
      if (btnExp) btnExp.disabled = false;
      // 精修产物换了：盲听旧映射作废（stopBlind 归位其按钮），
      // 重新实测精修后响度供证据链与导出对齐用
      stopBlind();
      state.lufs = state.lufs || { orig: null, proc: null };
      state.lufs.proc = E.measureLoudness(out);
      updateLufsState();
      updateLoudCurve('proc');   // 响度走势：叠上精修后曲线
      buildAiDossier();
      btn.textContent = '重新精修';
      setStatus('精修完成，可 A/B 对比、等响盲听、导出合规响度，或进入再生', false);
      await flushSave();
    } catch (err) {
      console.error(err);
      btn.textContent = '精修失败，请重试';
    }
    btn.disabled = false;
  }

  /* ============================================================
     L3 再生
     ============================================================ */
  // 拍号跟原曲走：显示体检检出值，再生按它写小节线
  function syncMeterBadge(meterOverride) {
    const el = $('#meterOut');
    if (!el) return;
    const fromL1 = state.profile?.identity?.meter;
    const m = meterOverride || fromL1;
    el.textContent = m || '未定 · 按 4/4';
    // 出处必须分清：L1 没测出时 renderArrangement 回落 4/4，
    // 再把这 4/4 标成「来自 L1 体检」，是给一个没人测过的数字编来源。
    el.title = !m
      ? '体检未给出拍号，再生回落 4/4'
      : fromL1
        ? '再生按此拍号写小节线（来自 L1 体检）'
        : `L1 未测出拍号，再生按 ${m} 回落（非体检结果）`;
    // 提示只在体检之后改写：还没体检时「原曲未定」是错的，那只是没看过。
    const hint = $('#meterHint');
    if (hint && state.profile) {
      hint.textContent = fromL1 ? '跟原曲走，不另设' : '原曲未定 · 按 4/4 兜底';
    }
  }

  function buildModeSelect() {
    const wrap = $('#modeSelect');
    wrap.innerHTML = '';
    syncMeterBadge();
    // 默认跟随体检检出的调式，而不是永远选中「宫」
    const wantId = state.profile?.identity?.mode || 'gong';
    let active = E.MODES.findIndex((m) => m.id === wantId);
    if (active < 0) active = 0;
    E.MODES.forEach((m, i) => {
      const b = document.createElement('button');
      b.className = 'chip' + (i === active ? ' is-active' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', i === active ? 'true' : 'false');
      b.dataset.i = String(i);
      b.innerHTML = `<span>${m.glyph}</span><small>${m.name}</small>`;
      b.addEventListener('click', () => {
        $$('#modeSelect .chip').forEach((x) => {
          x.classList.remove('is-active');
          x.setAttribute('aria-checked', 'false');
        });
        b.classList.add('is-active');
        b.setAttribute('aria-checked', 'true');
        markArrangementStale(); // 调式变了，已渲染编曲过期
      });
      wrap.appendChild(b);
    });
  }

  // cache：恢复工作区时带上存盘的 L3 分析。渲染用 seed = 7，同一组参数必然出同一段谱，
  // 只有 analyze 这 ~0.2s 是白花的；stale 标记由调用方在恢复结束时另行回填。
  async function renderArrangement(cache) {
    if (state.renderBusy) return; // 互斥：连点「播放/渲染」不双渲染
    stopOnce();   // 出下一首：旧乐段在响也先停下
    state.renderBusy = true;
    const btn = $('#btnRender');
    const btnPlay = $('#btnPlayCreate');
    btn.disabled = true;
    if (btnPlay) btnPlay.disabled = true;
    btn.textContent = '渲染中…';
    const g = state.loadGen;
    try {
      const modeIndex = Number($('#modeSelect .chip.is-active')?.dataset.i || 0);
      const bpm = Number($('#bpmRange').value);
      const bars = Number($('#barsRange').value);
      const muted = { ...state.muted };

      const keyIdx = E.PC_NAMES.indexOf(state.profile?.identity?.key);
      const rootMidi = 60 + (keyIdx >= 0 ? keyIdx : 0); // 未定调时按 C 生成
      // 拍号跟原曲走：分析出 5/4 却按 4/4 再生，产品会自相矛盾
      const meter = state.profile?.identity?.meter || '4/4';

      const res = await E.renderArrangement({ rootMidi, modeIndex, bpm, bars, muted, meter });
      if (g !== state.loadGen) {
        // 渲染期间换了素材：丢弃旧调性结果，按钮文案复位（新流水线随后会自行重建 UI）
        btn.textContent = '渲染乐段';
        return;
      }
      // 渲染参数随产物固化：MIDI 导出/分轨重渲以此为准，不读滑块现值
      res.renderOpts = { rootMidi, modeIndex, bpm, bars, muted, seed: 7, meter };
      res.renderBpm = bpm;
      res.stale = false;
      state.arrangement = res;
      renderTracks(res.events);
      drawPiano($('#chartPiano'), res.events);
      const cachedA = cache && cache.profileArrangement && cache.profileArrangement.meta
        ? cache.profileArrangement : null;
      state.profileArrangement = cachedA || E.analyze(res.buffer);
      // 再生乐段是派生产物，不能冒充原曲身份：保留自身 bpm/duration，用 derived_from 标注来源
      state.profileArrangement.meta.derived_from = state.profile?.meta?.source_file || null;
      state.profileArrangement.meta.artifact = 'arrangement';
      // 再生是我们自己写的谱，拍号是真值不是估计值
      if (res.meter) {
        state.profileArrangement.identity.meter = res.meter;
        state.profileArrangement.identity.meterConfidence = 1;
        state.profileArrangement.identity.meterSource = 'authored';
        syncMeterBadge(res.meter);
      }

      addVersionNode(E.MODES[modeIndex].name + ' 再生',
        `${bpm} BPM · ${bars} 小节 · ${res.events.length} 个音符`);

      btn.textContent = '重新渲染';
      setStatus(`已生成 ${res.events.length} 个音符，可导出 MIDI 与分轨`, false);
      await flushSave();
    } catch (err) {
      console.error(err);
      btn.textContent = '渲染失败，请重试';
    } finally {
      state.renderBusy = false;
      btn.disabled = false;
      if (btnPlay) btnPlay.disabled = false;
    }
  }

  /* ============================================================
     回流质检
     ============================================================ */
  function runRecheck() {
    const items = $$('.check');
    const origin = state.profile;
    const derived = state.profileArrangement || state.profileProcessed;

    const setResult = (el, cls, value, note) => {
      el.className = 'check ' + cls;
      el.querySelector('.check-value').textContent = value;
      el.querySelector('p').textContent = note;
    };

    if (!origin || !derived) {
      items.forEach((el) =>
        setResult(el, 'is-warn', '缺少产物', '请先完成精修或再生，再执行回流体检。'));
      return;
    }

    const o = origin.identity, d = derived.identity;
    const q = derived.quality;

    // 检查项名是「调式一致性」：只比 mode。用 || 会把故意调式互转判绿；
    // 用 && 又会把纯移调（C宫→D宫，调式未变）误报成「调式发生变化」。
    const modeOk = o.mode === d.mode;
    // 回流质检问的是「派生有没有守住原作」，不是「这张母带能不能发」。
    // 所以音质项看的是派生没有比原作更脏、没有把动态压死、没有削掉峰值余量。
    const oq = origin.quality;
    const residD = residualRatio(q);
    const residO = residualRatio(oq);
    const isArrangement = derived === state.profileArrangement;
    const crestOk = q.crest != null && q.peak != null ? (q.crest >= 6 && q.peak < 0.995) : true;
    let thdOk, lraOk, qNotePass, qNoteFail;
    if (isArrangement) {
      // 乐段是本机新写的谱子，没被任何处理压过，说它「退化/被压得过平」是假话。
      // 而且它的 LRA 只由小节数和速度决定（实测 2小节@40→8.3dB、
      // 8小节@139.9→3.5dB、12小节@200→1.8dB），拿原曲 13.9dB×0.45=6.25dB 当线，
      // 等于让滑块决定音质项过不过：同一段合成，2 小节过、8 小节不过。
      // 这里改成查乐段自身干不干净——阈值取自上面 6 组实测的包络外侧。
      thdOk = residD == null || residD <= 0.05;
      lraOk = q.lra == null || q.lra >= 1.5;
      qNotePass = '乐段由本机合成，残余与动态自查合格，峰值余量正常。';
      qNoteFail = `乐段自身不合格：`;
    } else {
      // 同全长精修才是「守住原作水准」：长度一致、且真的被处理过。
      // 未测得残余比时不判退化（null 不能当 0 参与比较）
      thdOk = residD == null || residO == null ? true : residD <= residO + 0.08;
      lraOk = q.lra != null && oq.lra != null ? q.lra >= oq.lra * 0.45 : true;
      qNotePass = residD == null
        ? '残余能量比未测得，动态范围与峰值余量守住原作水准。'
        : '残余能量、动态范围与峰值余量均守住原作水准。';
      qNoteFail = `派生在这些项上退化：`;
    }
    const qualityOk = thdOk && lraOk && crestOk;
    const qBits = [
      thdOk ? null : (isArrangement ? '残余能量偏高' : '残余能量上升'),
      lraOk ? null : (isArrangement ? '动态过平' : '动态被压得过平'),
      crestOk ? null : '峰值余量不足',
    ].filter(Boolean);
    // 结构项按产物类型分口径：
    // - profileProcessed 是同全长精修，段数可与原作比；
    // - profileArrangement 是按 bars/bpm 新写的短乐段（默认 8 小节约 21 秒），
    //   与全曲段落数不是一个尺度（detectStructure 对 <44s 产物最多 2 段），
    //   跨尺度比段数在真实歌曲上恒失败——改校验乐段自身是否符合设定。
    let structOk, structValue, structNote;
    if (isArrangement) {
      const modeIndex = Number($('#modeSelect .chip.is-active')?.dataset.i || 0);
      const wantMode = E.MODES[modeIndex].id;
      const wantBpm = Number($('#bpmRange').value);
      const wantBars = Number($('#barsRange').value);
      // duration 是 renderArrangement 按 bars/bpm 算出的真值，和当前滑杆不一致
      // 说明渲染后又改过设定（产物过期），需要重新渲染。
      const expectSec = (wantBars * 4 * 60) / wantBpm;
      const gotSec = state.arrangement?.duration ?? null;
      const durOk = gotSec != null && Math.abs(gotSec - expectSec) < 0.01;
      // 乐段是在纯五声音阶上合成的，detectMode 在此可靠；不用估计 BPM 硬比滑杆值。
      const modeHit = derived.identity.mode === wantMode;
      structOk = durOk && modeHit;
      structValue = `乐段 ${derived.structure.length} 段 · ${wantBars} 小节`;
      structNote = structOk
        ? `乐段按 ${wantBars} 小节 · ${wantBpm} BPM · ${E.MODES[modeIndex].name} 生成，结构自洽。`
        : `乐段与当前设定不符（目标 ${wantBars} 小节 · ${wantBpm} BPM · ${E.MODES[modeIndex].name}），请重新渲染。`;
    } else {
      // 同全长精修：允许短曲只有 1 段；关键是派生没有大幅改写段落骨架
      const drift = Math.abs(derived.structure.length - origin.structure.length);
      structOk = drift <= Math.max(1, Math.floor(origin.structure.length * 0.34));
      structValue = `${origin.structure.length} 段 → ${derived.structure.length} 段`;
      structNote = structOk
        ? (origin.structure.length <= 1
            ? '短曲单段结构，派生保持原作能量曲线。'
            : '段落骨架完整，能量曲线保持原作结构。')
        : '段落数变化较大，请检查结构划分。';
    }

    const results = [
      [items[0], modeOk, `${o.key}${o.modeGlyph} → ${d.key}${d.modeGlyph}`,
        modeOk ? '调式保持一致，派生未偏离原作骨架。' : '调式发生变化，请确认是否为有意转换。'],
      [items[1], qualityOk,
        `${residD != null ? (residD * 100).toFixed(1) + '%' : '—'} · ` +
        `${q.lra != null ? q.lra.toFixed(1) + ' dB' : '—'}`,
        qualityOk ? qNotePass : `${qNoteFail}${qBits.join('、')}。`],
      [items[2], structOk, structValue, structNote],
    ];

    results.forEach(([el, ok, value, note], i) => {
      setTimeout(() => setResult(el, ok ? 'is-ok' : 'is-warn', value, note), 220 * i);
    });

    const passed = results.filter((r) => r[1]).length;
    addVersionNode('回流质检',
      `${passed}/3 项通过 · ${results.map((r) => r[2]).join(' · ')}`);
    setStatus(`回流体检完成 · ${passed}/3 项通过`, passed === 3);
    scheduleSave();
  }

  /* ============================================================
     导出
     ============================================================ */
  /* 源文件名去掉扩展名，拿不到就退回「原曲」——导出文件名不能是 undefined */
  function baseName(src) {
    if (!src) return '原曲';
    const clean = String(src).replace(/^示例 · /, '');
    const i = clean.lastIndexOf('.');
    return i > 0 ? clean.slice(0, i) : clean;
  }

  /* 导出名带来源：同名文件覆盖是本地下载的常态，
     「红头绳_精修.wav」比第二个「精修.wav」更难被用户搞混。 */
  function wavName(base, suffix) {
    return `${base}_${suffix}.wav`;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2500);
  }

  function exportProfile() {
    // 音乐档案描述的是导入的这首歌（L1 体检写入），不是再生乐段/精修产物
    const p = state.profile;
    if (!p) {
      setStatus('请先完成体检，再导出音乐档案。', false);
      return;
    }
    const derive = (prof, scope) => prof ? {
      scope,
      duration_sec: prof.meta.duration,
      quality: {
        nonharmonic_ratio: residualRatio(prof.quality),
        lra: prof.quality.lra,
        crest: prof.quality.crest,
      },
      structure_segments: prof.structure.length,
    } : null;
    const payload = {
      meta: {
        id: 'local-' + Date.now(),
        source_file: p.meta.source_file || null,
        created_at: new Date().toISOString(),
        pipeline_version: '2.1.0-web',
      },
      identity: {
        bpm: p.identity.bpm,
        bpm_confidence: p.identity.bpmConfidence,
        key: p.identity.key,
        mode: p.identity.mode,
        mode_name: p.identity.modeName,
        mode_confidence: p.identity.modeConfidence,
        penta_fit: p.identity.pentaFit,
        // 西方调性：major/minor 与五声调式并列存档，不是替代关系
        tonality: p.identity.tonality,
        tonality_name: p.identity.tonalityName,
        tonality_confidence: p.identity.tonalityConfidence,
        western_key: p.identity.westernKey,
        time_signature: p.identity.meter,
        time_signature_confidence: p.identity.meterConfidence,
        time_signature_source: p.identity.meterSource || 'estimated',
        duration_sec: p.meta.duration,
      },
      structure: p.structure,
      timbre: p.timbre,
      culture: {
        scale_family: (p.identity.pentaFit || 0) > 0.55 ? 'pentatonic' : 'heptatonic',
        mode_family: p.identity.mode,
      },
      quality: {
        // 谐波外残余能量比（0–1，越低越好）；nonharmonic_coverage 表示有多少帧具备可辨谐波结构。
        // thd 恒为 null：产品不测量谐波失真，历史键 thd 实为残余比，不再冒充 THD。
        thd: null,
        nonharmonic_ratio: residualRatio(p.quality),
        nonharmonic_coverage: coverageOf(p.quality),
        lra: p.quality.lra,
        crest: p.quality.crest,
        low_ratio: p.quality.lowRatio,
        sub_ratio: p.quality.subRatio,
        // 低频缺陷分 = max(谐波间涂抹, 工频哼声)；两个分量分开导出，
        // 成因不同（涂抹是能量摊在泛音列外，哼声是 50/60Hz 窄带纯音）。
        mud_score: p.quality.mudScore,
        mud_smear: p.quality.mudSmear,
        hum_score: p.quality.humScore,
        hum_freq: p.quality.humFreq,
        // 分诊：mains=工频哼声(50/60) / ripple=整流纹波(100/120) / narrowband=窄带峰 / none
        hum_kind: p.quality.humKind || 'none',
        hum_prominence: p.quality.humProminence,
      },
      melody: p.melody,
      // BS.1770 门限后积分响度（L1 实测；null 就是没测出，不编）
      loudness: {
        original_lufs: state.lufs && state.lufs.orig ? state.lufs.orig.lufs : null,
        original_peak_db: state.lufs && state.lufs.orig ? state.lufs.orig.peakDb : null,
        processed_lufs: state.lufs && state.lufs.proc ? state.lufs.proc.lufs : null,
        export_target: lufsTargetOf().lufs,
      },
      // 派生分析单列收纳，标明各自描述对象，不再冒充原曲度量
      derivation: {
        refine: derive(state.profileProcessed, 'processed'),
        arrangement: derive(state.profileArrangement, 'synthesized-arrangement'),
        structure_edits: state.structHistory.length,
      },
      provenance: {
        versions: state.versionTree.map((v, i) => ({
          id: 'v' + (i + 1), title: v.title, meta: v.meta,
        })),
      },
    };
    download(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      'music_profile.json'
    );
    setStatus('已导出音乐档案 music_profile.json', false);
  }

  /* ============================================================
     工作区存盘 / 恢复
     ------------------------------------------------------------
     刷新页面 = 浏览器再也不认得用户选的那个文件。这里把源字节和
     全部参数落进 IndexedDB，回来时重放一遍 L1→L3 拿回工作区；
     派生 PCM 不存，见 store.js 顶上的说明。
     ============================================================ */
  const Store = window.SonicStore || null;
  let saveTimer = 0;
  let lastFP = null;
  let restoring = false;

  function modeIndexNow() {
    return Number(document.querySelector('#modeSelect .chip.is-active')?.dataset.i || 0);
  }

  /* 会话指纹：滑块拖一下就是一个 input 事件，每次落库等于拖动期间
     反复序列化再写盘。先比指纹，没变直接返回。 */
  function sessionFP() {
    if (!state.profile) return 'empty';
    return JSON.stringify({
      src: state.profile.meta.source_file,
      dur: state.profile.meta.duration,
      strength: $('#strength') && $('#strength').value,
      eq: state.eqParams,
      eqTag: $('#eqTag') && $('#eqTag').textContent,
      bpm: $('#bpmRange') && $('#bpmRange').value,
      bars: $('#barsRange') && $('#barsRange').value,
      mode: modeIndexNow(),
      material: state.material,
      muted: state.muted,
      hasProc: !!state.processedBuffer,
      hasArr: !!state.arrangement,
      arrStale: !!(state.arrangement && state.arrangement.stale),
      showing: state.showingAfter,
      tree: state.versionTree.length,
      checks: $$('.check').map((c) => c.className).join('|'),
      struct: state.structHistory.length,
      lufsT: state.lufsTarget,
    });
  }

  /* 拖滑块用去重窗口：一次 input 一个事件，逐个落库等于拖动期间反复写。
     跑完流水线（体检/精修/渲染）直接 flushSave 等它写完——
     「渲染完成」和「已存盘」之间不该还隔着一个能丢数据的窗口。 */
  function scheduleSave(delay = 400) {
    // 恢复进行中不许写：重放到一半的状态（比如精修还没跑完）落库，
    // 会把上一次已经存好的 processed 标记抹掉
    if (restoring || !Store) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWorkspace, delay);
  }

  async function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (restoring || !Store) return;
    await saveWorkspace();
  }

  async function saveWorkspace() {
    if (restoring || !Store || !state.profile || !state._srcBytes) return;
    const fp = sessionFP();
    if (fp === lastFP) return;
    const name = state.profile.meta.source_file;
    try {
      const r = await Store.save({
        assetId: await Store.assetId(state._srcKind, name, state._srcBytes),
        bytes: state._srcBytes,
        source: { name, kind: state._srcKind, size: state._srcSize },
        profile: state.profile,
        strength: Number(($('#strength') && $('#strength').value) || 55) / 100,
        eq: state.eqParams ? Array.from(state.eqParams) : null,
        eqManual: !!state.eqManual,
        bpm: Number(($('#bpmRange') && $('#bpmRange').value) || 92),
        bars: Number(($('#barsRange') && $('#barsRange').value) || 8),
        modeIndex: modeIndexNow(),
        material: state.material,
        muted: { ...state.muted },
        processed: !!state.processedBuffer,
        profileProcessed: state.profileProcessed,
        arrangement: !!state.arrangement,
        arrStale: !!(state.arrangement && state.arrangement.stale),
        profileArrangement: state.profileArrangement,
        showingAfter: state.showingAfter,
        checksRan: $$('.check').some((c) => /is-ok|is-warn/.test(c.className)),
        tree: state.versionTree.map((n) => ({ title: n.title, meta: n.meta })),
        // 结构编辑历史、整曲名与响度目标：store 直通透传，无需升 schema。
        // 历史里每一项是一份完整计划（段数组），必须再 map 一层——
        // 少了内层就把计划压成 {}，恢复时折叠必败
        structHistory: state.structHistory.map((plan) =>
          plan.map((p) => ({ s: p.s, e: p.e, l: p.l }))),
        fileLabel: state.fileLabel,
        lufsTarget: state.lufsTarget,
      });
      // 指纹必须记下：不记的话每次触发都整条重写，
      // 拖一下滑块就是一次几十 KB 的落库，纯浪费
      if (r.ok) { lastFP = fp; markSaved(name); }
      else if (r.reason === 'too-large') markSaveSkipped(r.bytes);
    } catch (err) {
      console.info('[store] 存盘失败', err);
    }
  }

  function markSaved(name) {
    const el = $('#saveStatus');
    if (el) {
      el.hidden = false;
      el.textContent = `已自动存盘 · ${name} · 刷新页面可恢复`;
    }
    const btn = $('#btnClearWs');
    if (btn) btn.hidden = false;
  }

  function markSaveSkipped(bytes) {
    const el = $('#saveStatus');
    if (!el) return;
    el.hidden = false;
    el.textContent =
      `源文件 ${(bytes / 1048576).toFixed(0)} MB，超过 ` +
      `${(Store.MAX_BYTES / 1048576).toFixed(0)} MB 上限，本次不存盘`;
  }

  async function restoreWorkspace() {
    if (!Store) return false;
    // ?fresh=1：清掉存盘再启动。测试、演示、以及单纯想从头来都走这条
    if (/[?&]fresh=1/.test(location.search)) {
      await Store.clear();
      return false;
    }
    // 自动示例要接管素材，两条路不能同时走
    if (/[?&]demo=1/.test(location.search)) return false;

    const rec = await Store.load();
    if (!rec) return false;

    restoring = true;
    const gen = ++state.loadGen;
    try {
      setStatus('正在恢复上次的工作区…', true);
      let buf;
      try {
        // 存盘的字节还要留作下一次写库，这里必须给一份副本：
        // decodeAudioData 在部分实现里会掏空传入的 ArrayBuffer
        buf = await getCtx().decodeAudioData(rec.bytes.slice(0));
      } catch (err) {
        console.info('[store] 源素材解码失败，放弃恢复', err);
        setStatus('上次的素材无法解码，已从空工作区开始。', false);
        return false;
      }
      if (gen !== state.loadGen) return false;

      state._srcBytes = rec.bytes;
      state._srcSize = (rec.source && rec.source.size) || rec.bytes.byteLength;
      state._srcKind = (rec.source && rec.source.kind) || 'file';

      // 响度目标与结构历史先归位：runPipeline 里的
      // buildLufsTargets / buildStructPlan 都要读它们
      state.lufsTarget = rec.lufsTarget || 'off';
      let hist = Array.isArray(rec.structHistory) ? rec.structHistory : [];
      let cached = rec.profile;
      let fold = buf;
      if (hist.length) {
        // 结构编辑历史：从解码后的整曲按序折叠出「最后听到的那份音频」。
        // 每个计划段的秒数是相对它当时那份输入的，顺序重放即可复原。
        try {
          for (const plan of hist) {
            const folded = spliceSegments(fold, plan);
            if (!folded) throw new Error('计划拼不出音频');
            fold = folded;
          }
        } catch (err) {
          console.info('[store] 结构折叠失败，按原始素材恢复', err);
          fold = buf;
          hist = [];
          cached = null;  // 存盘的 profile 对应折叠后的音频，原曲对不上就不能用
        }
      }
      state.structHistory = hist;
      state.fileBuffer = buf;
      // 整曲名：优先存盘的 fileLabel；旧记录退回 source.name 并剥掉
      // 可能存在的「 · 结构改版」尾巴，免得跨会话叠成两遍
      state.fileLabel =
        rec.fileLabel ||
        (((rec.source && rec.source.name) || '恢复的素材')
          .replace(/( · 结构改版)+$/, ''));

      await runPipeline(
        fold,
        (rec.source && rec.source.name) || '恢复的素材',
        gen, cached, true
      );
      if (gen !== state.loadGen) return false;

      // 素材类型要在 processAudio 之前归位：精修跑哪条链由它决定。
      // runPipeline 里刚被重置成默认值，这里改回来并把处方重画一遍；
      // 顺序必须在下面的 rec.eq 之前，否则重画处方会把恢复的 EQ 又盖掉。
      if (rec.material && rec.material !== state.material) state.material = rec.material;
      buildSourceKind();
      buildPrescription(state.profile);

      // 参数先归位，再重放下游动作——精修 / 渲染 / 回流都从 DOM 和 state 读参数
      if (rec.strength != null) {
        const pct = Math.round(rec.strength * 100);
        $('#strength').value = String(pct);
        $('#strengthTag').textContent = '强度 ' + pct + '%';
      }
      if (Array.isArray(rec.eq)) {
        const eq = rec.eq.slice(0, 10);
        while (eq.length < 10) eq.push(0);
        state.eqParams = eq;
        syncEqBands();          // 这会把标签打回「按处方预置」，手动标记要在它之后写
        state.eqManual = !!rec.eqManual;
        if (state.eqManual) $('#eqTag').textContent = '已手动调整';
      }
      if (rec.bpm) { $('#bpmRange').value = String(rec.bpm); $('#bpmOut').textContent = rec.bpm + ' BPM'; }
      if (rec.bars) { $('#barsRange').value = String(rec.bars); $('#barsOut').textContent = rec.bars + ' 小节'; }
      if (rec.modeIndex != null) {
        // 要点真 click：只有它会同步 aria-checked 和 is-active，赋 dataset 不会
        const chip = document.querySelector(`#modeSelect .chip[data-i="${rec.modeIndex}"]`);
        if (chip) chip.click();
      }
      state.muted = rec.muted || {};

      if (rec.processed) await processAudio({ profileProcessed: rec.profileProcessed });
      if (rec.arrangement) {
        await renderArrangement({ profileArrangement: rec.profileArrangement });
        if (rec.arrStale) markArrangementStale();
      }
      if (rec.checksRan && (state.profileProcessed || state.profileArrangement)) runRecheck();

      // 版本树按存盘原样落回：重放只生成「跑一遍」的节点，
      // 用户重跑过几次精修这类历史靠重放凑不出来
      if (Array.isArray(rec.tree) && rec.tree.length) {
        state.versionTree = rec.tree;
        renderTree();
      }
      if (state.processedBuffer && rec.showingAfter) setWaveView(true);

      const name = (rec.source && rec.source.name) || state.profile.meta.source_file;
      markSaved(name);
      setStatus(`已恢复上次工作区 · ${name}`, false);
      return true;
    } catch (err) {
      console.error('[store] 恢复失败', err);
      setStatus('恢复工作区失败，已按新会话开始。', false);
      return false;
    } finally {
      restoring = false;
      // 收尾再对一次指纹：恢复期间攒下的 scheduleSave 全被挡掉了，
      // 这里以最终状态为准补齐，之后的变化才继续走正常存盘
      lastFP = null;
      scheduleSave();
    }
  }

  /* ============================================================
     事件
     ============================================================ */
  function bind() {
    const dz = $('#dropzone');
    const input = $('#fileInput');
    const openPicker = () => input.click();

    $('#btnPick').addEventListener('click', openPicker);
    $('#btnHeroStart').addEventListener('click', openPicker);

    const loadFile = async (file) => {
      if (!file) return;
      const gen = ++state.loadGen;
      setStatus('解码 ' + file.name + '…', true);
      let bytes, buf;
      try {
        bytes = await file.arrayBuffer();
        // 另给一份副本去解码：源字节要留着存盘，
        // decodeAudioData 在部分实现里会掏空传入的 ArrayBuffer
        buf = await getCtx().decodeAudioData(bytes.slice(0));
      } catch (err) {
        console.error(err);
        setStatus('无法解码该文件，请换一种格式。', false);
        return;
      }
      if (gen !== state.loadGen) return; // 已被更新的导入取代
      state._srcBytes = bytes;
      state._srcSize = file.size;
      state._srcKind = 'file';
      try {
        await runPipeline(buf, file.name, gen);
      } catch (err) {
        console.error(err);
        setStatus('体检失败，请重试。', false);
      }
    };

    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      // 清空 value，否则重新选同一个文件不会再触发 change
      input.value = '';
      loadFile(f);
    });
    dz.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openPicker();
    });
    dz.addEventListener('keydown', (e) => {
      // 只处理 dropzone 自身的按键；内部按钮（试跑示例/选择文件）的
      // Enter/Space 交给浏览器原生激活，不能被劫持成打开文件框
      if (e.target !== dz) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
    });

    ['dragenter', 'dragover'].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('is-over'); }));
    dz.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    /* 合成示例：?synth=1 专用，以及真歌素材缺失时的兜底。
       产品门面是下面那首真歌——合成曲是自己造的毛病（人造隆隆声+底噪），
       拿它当门面等于让 L2 去修一个为了被修而存在的问题。 */
    const runSynthDemo = async (gen) => {
      setStatus('正在合成示例音频…', true);
      const buf = await E.synthesizeDemo();
      if (gen !== state.loadGen) return;
      // Math.random() 合成，刷新之后无从重算，字节必须入库。
      // 24 位已把量化底噪压到约 -140dB，听感与后续分析都察觉不到。
      const wav = await E.bufferToWav(buf, 24).arrayBuffer();
      if (gen !== state.loadGen) return;
      state._srcBytes = wav;
      state._srcSize = wav.byteLength;
      state._srcKind = 'demo';
      await runPipeline(buf, '示例 · 五声调式合成.wav', gen);
    };

    const runDemo = async () => {
      const gen = ++state.loadGen;
      if (/[?&]synth=1/.test(location.search)) {
        try { await runSynthDemo(gen); }
        catch (err) { console.error(err); setStatus('示例合成失败。', false); }
        return;
      }
      setStatus('正在载入真歌示例…', true);
      try {
        // 素材是 FLAC（文件名带 .mp3 是原下载时的误标），按真格式放，别再谎报扩展名
        const res = await fetch('assets/ai-song-demo.flac');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const bytes = await res.arrayBuffer();
        if (gen !== state.loadGen) return;
        const buf = await getCtx().decodeAudioData(bytes.slice(0));
        if (gen !== state.loadGen) return;
        // 有真文件就按 file 记：内容固定，assetId 稳定，反复跑示例不会重写这 20MB
        state._srcBytes = bytes;
        state._srcSize = bytes.byteLength;
        state._srcKind = 'file';
        await runPipeline(buf, '示例 · 龙城风·巷砖记-古方路杰出青年.flac', gen);
      } catch (err) {
        console.error(err);
        // 素材没随部署拷过去、或本地服务没挂上 assets：示例按钮不能就这么死了
        setStatus('真歌示例素材缺失，改用合成示例。', false);
        try { await runSynthDemo(gen); }
        catch (err2) { console.error(err2); setStatus('示例加载失败。', false); }
      }
    };
    $('#btnDemo').addEventListener('click', runDemo);
    $('#btnHeroDemo').addEventListener('click', runDemo);

    // L2
    // 包一层箭头函数：processAudio/renderArrangement 的首参是恢复用的 cache，
    // 直接当监听器会把 MouseEvent 传进去
    $('#btnProcess').addEventListener('click', () => processAudio());
    $('#strength').addEventListener('input', (e) => {
      $('#strengthTag').textContent = '强度 ' + e.target.value + '%';
    });

    /* ---- 走带：试听 / 播放 / 暂停 ---- */
    $('#btnListen')?.addEventListener('click', togglePlay);
    $('#btnWavePlay')?.addEventListener('click', togglePlay);

    /* 进度条点击跳转 + 键盘（←/→ ±5s，Home/End 首尾） */
    const bar = $('#wavePlayBar');
    const seekFromEvent = (e) => {
      if (!T.buffer) return;
      const r = bar.getBoundingClientRect();
      const x = (e.clientX ?? (e.touches && e.touches[0].clientX) ?? 0) - r.left;
      seekTo((Math.max(0, Math.min(x, r.width)) / Math.max(r.width, 1)) * T.buffer.duration);
    };
    bar?.addEventListener('click', seekFromEvent);
    bar?.addEventListener('keydown', (e) => {
      if (!T.buffer) return;
      const pos = tPos();
      if (e.key === 'ArrowLeft')  { e.preventDefault(); seekTo(pos - 5); }
      if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(pos + 5); }
      if (e.key === 'Home')       { e.preventDefault(); seekTo(0); }
      // End = 停在末尾（不是被 playBuffer 的「到头回开头」弹回 0）
      if (e.key === 'End') {
        e.preventDefault();
        if (T.playing) pauseBuffer();
        T.offset = T.buffer.duration;
        syncTransportUI();
      }
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); togglePlay(); }
    });

    /* 点波形任意位置跳转 —— 看着哪就能从哪听 */
    $('#chartWave')?.addEventListener('click', (e) => {
      const buf = state.showingAfter && state.processedBuffer
        ? state.processedBuffer
        : (state.processedBuffer || state.originBuffer);
      if (!buf) return;
      const cv = e.currentTarget;
      const r = cv.getBoundingClientRect();
      // drawWave 的左右留白各 10px（CSS 像素）
      const pad = 10;
      const x = e.clientX - r.left - pad;
      const gw = Math.max(1, r.width - pad * 2);
      const target = (Math.max(0, Math.min(x, gw)) / gw) * buf.duration;
      if (T.buffer !== buf) { playBuffer(buf, null, target); return; }
      const was = T.playing;
      seekTo(target);
      if (!was) playBuffer(buf, null, target);   // 停着时点一下就从这开始放
    });

    $('#btnAB').addEventListener('click', () => {
      if (!state.processedBuffer) return;
      const next = !state.showingAfter;
      setWaveView(next, next ? '当前播放精修后波形（A/B 对比）' : '当前播放原始波形（A/B 对比）');
      if (!T.playing) togglePlay();   // 点 A/B 就直接开听
    });
    $$('.chip[data-wave]').forEach((c) =>
      c.addEventListener('click', () => {
        // 未精修时点「精修后」会被 setWaveView 拦回原始波，不冒充精修波
        setWaveView(c.dataset.wave === 'after');
      }));

    // L3
    $('#bpmRange').addEventListener('input', (e) => {
      $('#bpmOut').textContent = e.target.value + ' BPM';
      markArrangementStale();
    });
    $('#barsRange').addEventListener('input', (e) => {
      $('#barsOut').textContent = e.target.value + ' 小节';
      markArrangementStale();
    });
    $('#btnRender').addEventListener('click', () => renderArrangement());
    $('#btnPlayCreate').addEventListener('click', (e) => {
      if (ONCE.src && ONCE.btn === e.currentTarget) { stopOnce(); return; } // 播放中即停止，不被 stale 拦住
      if (state.arrangement) {
        if (state.arrangement.stale) {
          setStatus('参数已修改，请重新渲染乐段，再播放。', false);
          return;
        }
        playOnce(state.arrangement.buffer, e.currentTarget);
      } else {
        renderArrangement();
      }
    });
    /* zip 里的清单：只写这份包里真实存在的东西，数字全部来自渲染快照。
       分轨规格是 renderArrangement 的固定口径——离线上下文恒为 44100Hz 立体声，
       导出这里给了 24 位。 */
    const manifestText = (a, m, kept) => {
      const list = a.tracks.filter((t) => kept.includes(t.id));
      return [
        '音智新媒 · 再生乐段分轨',
        '',
        `来源：${m.src}`,
        `速度：${m.bpm} BPM`,
        `拍号：${m.meter}`,
        `小节：${m.bars == null ? '—' : m.bars}`,
        `时长：${(a.duration || 0).toFixed(1)} s`,
        '',
        '分轨（每轨独奏渲染，24-bit / 44100 Hz 立体声 WAV）：',
        ...list.map((t) => `  arrangement_${t.id}.wav  ${t.name}`),
        '',
        'MIDI：arrangement.mid（SMF Format 1，一轨一乐器，含速度与拍号）',
        '',
      ].join('\n');
    };

    /* MIDI 与分轨共用的元数据，全部取渲染时的快照——
       events 的拍点是按那一刻的 BPM 排的，拿滑块现值去换算 tick 会整体错位。 */
    const arrangementMeta = (a) => {
      const bpm = a.renderBpm ?? Number($('#bpmRange').value);
      const meter = a.meter || (a.renderOpts && a.renderOpts.meter) || '4/4';
      const bars = (a.renderOpts && a.renderOpts.bars) || null;
      const src = baseName(state.profile?.meta?.source_file);
      return {
        bpm, meter, bars, src,
        title: `${src} · 再生乐段`,
        note: `${bpm} BPM · ${meter}${bars ? ' · ' + bars + ' 小节' : ''}`,
      };
    };

    $('#btnExportMidi').addEventListener('click', () => {
      const a = state.arrangement;
      if (!a) {
        setStatus('请先渲染乐段，再导出 MIDI。', false);
        return;
      }
      if (a.stale) {
        setStatus('参数已修改，请重新渲染乐段，再导出 MIDI。', false);
        return;
      }
      try {
        const m = arrangementMeta(a);
        download(E.eventsToMidi(a.events, m), 'arrangement.mid');
        const nTracks = new Set(a.events.map((e) => e.track || '_')).size;
        setStatus(`已导出 arrangement.mid · ${m.bpm} BPM · ${m.meter} · ${nTracks} 轨`, false);
      } catch (err) {
        console.error(err);
        setStatus('导出 MIDI 失败，请重试。', false);
      }
    });

    /* 分轨 = 一轨独奏（其余静音）离线重渲，和 MIDI、清单一起打进一个 zip。
       原本是连发 5 次下载：浏览器会拦「多次下载」，拦下之后用户只拿到
       第一条，还以为分轨坏了。打包成一次交付，两个问题一起没了。
       WAV 走 24 位，和精修/混音导出同一口径。 */
    $('#btnExportStems').addEventListener('click', async () => {
      const a = state.arrangement;
      if (!a) {
        setStatus('请先渲染乐段，再导出分轨。', false);
        return;
      }
      if (a.stale) {
        setStatus('参数已修改，请重新渲染乐段，再导出分轨。', false);
        return;
      }
      const btn = $('#btnExportStems');
      btn.disabled = true;
      btn.textContent = '打包中…';
      try {
        const ids = a.tracks.map((t) => t.id); // lead/harm/bass/drums/pad
        const base = a.renderOpts;
        const files = [];
        const kept = [];
        for (const id of ids) {
          // 混音里被用户静音的轨不含在编曲中，跳过以保持分轨与混音一致
          if (base && base.muted && base.muted[id]) continue;
          const muted = {};
          ids.forEach((x) => { if (x !== id) muted[x] = true; });
          const stem = await E.renderArrangement({ ...(base || {}), muted });
          const wav = await E.bufferToWav(stem.buffer, 24).arrayBuffer();
          files.push({ name: `arrangement_${id}.wav`, data: new Uint8Array(wav) });
          kept.push(id);
        }
        if (!files.length) {
          setStatus('当前编曲全部轨道已静音，没有可导出的分轨。', false);
          return;
        }
        const m = arrangementMeta(a);
        files.push({
          name: 'arrangement.mid',
          data: new Uint8Array(await E.eventsToMidi(a.events, m).arrayBuffer()),
        });
        files.push({
          name: 'manifest.txt',
          data: new TextEncoder().encode(manifestText(a, m, kept)),
        });

        const zipName = `${m.src}_分轨.zip`;
        download(E.makeZip(files), zipName);
        setStatus(`已导出 ${zipName}：${kept.length} 条分轨 + arrangement.mid`, false);
      } catch (err) {
        console.error(err);
        setStatus('导出分轨失败，请重试。', false);
      } finally {
        btn.disabled = false;
        btn.textContent = '导出分轨';
      }
    });
    // 精修整曲：L2 的产物是产品的主张本身——「加工成可发行的音乐资产」。
    // 没有这条出口，用户调完强度和 EQ 只能在浏览器里听，拿不走。
    $('#btnExportProcessed').addEventListener('click', () => {
      const buf = state.processedBuffer;
      if (!buf) {
        setStatus('请先执行精修，再导出精修音频。', false);
        return;
      }
      try {
        const name = wavName(baseName(state.profile?.meta?.source_file), '精修');
        const target = lufsTargetOf();
        if (target.lufs == null) {
          download(E.bufferToWav(buf, 24), name);
          setStatus(`已导出 ${name}`, false);
          return;
        }
        // 平台响度合规：常数增益对齐目标，峰值 −1 dBFS 顶线时如实上报
        const r = E.matchLoudness(buf, target.lufs, -1);
        download(E.bufferToWav(r.buffer, 24), name);
        state.lufs = state.lufs || { orig: null, proc: null };
        state.lufs.proc = r.after;
        updateLufsState();
        setLoudCurveProc(r.buffer);   // 导出的是对齐版，走势曲线跟着换成对齐后实测
        buildAiDossier();
        const hit = r.after.lufs != null
          ? `实测 ${r.after.lufs} LUFS` : '实测不可得';
        setStatus(
          `已导出 ${name} · ${r.gain > 0 ? '+' : ''}${r.gain} dB → ${hit}` +
          `（目标 ${target.lufs}` +
          (r.limited ? ' · 峰值 −1 dBFS 顶到，目标未完全达成）' : '）'),
          false
        );
      } catch (err) {
        console.error(err);
        setStatus('导出精修音频失败，请重试。', false);
      }
    });

    // 乐段混音：分轨是给二次创作的，混音才是能直接听、直接交的成品。
    $('#btnExportMix').addEventListener('click', () => {
      const a = state.arrangement;
      if (!a || !a.buffer) {
        setStatus('请先渲染乐段，再导出混音。', false);
        return;
      }
      if (a.stale) {
        setStatus('参数已修改，请重新渲染乐段，再导出混音。', false);
        return;
      }
      try {
        const name = wavName(baseName(state.profile?.meta?.source_file), '乐段混音');
        download(E.bufferToWav(a.buffer, 24), name);
        setStatus(`已导出 ${name}`, false);
      } catch (err) {
        console.error(err);
        setStatus('导出混音失败，请重试。', false);
      }
    });

    $('#btnExportProfile').addEventListener('click', exportProfile);

    // 五线谱导出 PNG：谱面是纯 canvas，toBlob 直接落盘
    /* 五线谱卡收起/展开：折叠谱面主体省纵向空间，标题、标签与导出行留着。
       选择记进 localStorage（下次打开保持）；隐藏期画布只有兜底窄幅，
       展开时必须按当前可视宽度重绘。 */
    const scoreCardEl = $('#scoreCard');
    const btnScoreFold = $('#btnScoreFold');
    const applyScoreFold = (folded) => {
      if (!scoreCardEl || !btnScoreFold) return;
      scoreCardEl.classList.toggle('folded', folded);
      // hidden 属性兜底：即使样式表被浏览器缓存成旧版（没有 .folded 规则），
      // 只要 JS 生效谱面就一定收得起来
      const body = document.getElementById('scoreBody');
      if (body) {
        if (folded) body.setAttribute('hidden', '');
        else body.removeAttribute('hidden');
      }
      btnScoreFold.textContent = folded ? '展开' : '收起';
      btnScoreFold.setAttribute('aria-expanded', folded ? 'false' : 'true');
      if (!folded && state.profile) renderScoreCard(state.profile);
    };
    const persistScoreFold = (folded) => {
      try { localStorage.setItem('sonic.scoreFolded', folded ? '1' : '0'); } catch (e) { /* 隐私模式禁存储就只管本次 */ }
    };
    if (scoreCardEl && btnScoreFold) {
      let folded = false;
      try { folded = localStorage.getItem('sonic.scoreFolded') === '1'; } catch (e) {}
      applyScoreFold(folded);
      btnScoreFold.addEventListener('click', () => {
        const now = !scoreCardEl.classList.contains('folded');
        persistScoreFold(now);
        applyScoreFold(now);
      });
    }

    const btnScorePng = $('#btnScorePng');
    if (btnScorePng) btnScorePng.addEventListener('click', () => {
      const cv = $('#chartScore');
      if (!state.score || !cv) {
        setStatus('请先完成体检，再导出五线谱。', false);
        return;
      }
      // 收起时画布是兜底窄幅，先展开重绘再截，避免导出缩水的谱面
      if (scoreCardEl && scoreCardEl.classList.contains('folded')) {
        persistScoreFold(false);
        applyScoreFold(false);
      }
      cv.toBlob((blob) => {
        if (!blob) return;
        download(blob, `${baseName(state.profile && state.profile.meta.source_file)}_五线谱.png`);
      }, 'image/png');
    });

    // 五线谱导出 MusicXML：纯字符串生成，可进打谱软件继续编辑
    const btnScoreXml = $('#btnScoreXml');
    if (btnScoreXml) btnScoreXml.addEventListener('click', () => {
      if (!state.score) {
        setStatus('请先完成体检，再导出五线谱。', false);
        return;
      }
      const xml = buildMusicXml(state.score, state.profile);
      if (!xml) {
        setStatus('谱面数据不完整，导不出 MusicXML。', false);
        return;
      }
      const name = `${baseName(state.profile && state.profile.meta.source_file)}_五线谱.musicxml`;
      download(new Blob([xml], { type: 'application/vnd.musicxml+xml' }), name);
      setStatus(`已导出 ${name}`, false);
    });

    /* ---- 第一梯队创新 ---- */
    // 证据入口：点指标块（或键盘回车）切到对应证据页签并滚过去
    $$('.metric-ev').forEach((el) => {
      const go = () => {
        const tab = el.dataset.ev;
        if (tab) evTab = tab;
        buildEvidenceUI();
        const card = $('#evidenceCard');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
      el.addEventListener('click', go);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    });

    // 结构重排
    $('#btnStructDup').addEventListener('click', structDup);
    $('#btnStructDel').addEventListener('click', structDel);
    $('#btnStructMerge').addEventListener('click', structMerge);
    $('#btnStructLeft').addEventListener('click', structLeft);
    $('#btnStructApply').addEventListener('click', applyStructEdit);
    $('#btnStructReset').addEventListener('click', resetStructure);

    // 等响盲听
    $('#btnBlindStart').addEventListener('click', blindStart);
    $('#blindA').addEventListener('click', () => blindSwitch('A'));
    $('#blindB').addEventListener('click', () => blindSwitch('B'));
    $('#btnBlindReveal').addEventListener('click', blindReveal);
    $('#btnBlindStop').addEventListener('click', stopBlind);
    $('#btnPickA').addEventListener('click', () => blindPick('A'));
    $('#btnPickB').addEventListener('click', () => blindPick('B'));
    // 盲听中 a / b 键即时切听；在输入框里打字时不劫持
    document.addEventListener('keydown', (e) => {
      if (!blind.active) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = (e.key || '').toLowerCase();
      if (k === 'a' || k === 'b') {
        e.preventDefault();
        blindSwitch(k.toUpperCase());
      }
    });

    // 五调式互转试听
    $('#btnMelodyAudition').addEventListener('click', auditionMelody);

    // 有据 AI：接口设置弹窗 + 发送
    $('#btnAiSettings').addEventListener('click', openAiModal);
    $('#btnAiClose').addEventListener('click', closeAiModal);
    $('#btnAiSave').addEventListener('click', saveAiModal);
    $('#btnAiTest').addEventListener('click', testAiConn);
    $('#btnAiSend').addEventListener('click', aiSend);
    $('#aiInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); aiSend(); }
    });
    const aiModal = $('#aiModal');
    if (aiModal) {
      aiModal.addEventListener('click', (e) => {
        if (e.target === aiModal) closeAiModal();  // 点遮罩关闭
      });
    }
    aiSyncUI();

    // 回流
    $('#btnRecheck').addEventListener('click', runRecheck);

    // 响应式重绘
    let rt;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        if (state.profile) {
          drawSpectrum($('#chartSpectrum'),
            state.profile.quality.spectrum, state.profile.meta.sampleRate);
          drawStructure($('#chartStructure'),
            state.profile.structure, state.profile.meta.duration);
          drawEvidence();
          renderScoreCard(state.profile);
          drawLoudCurve($('#chartLoudCurve'));
        }
        drawEqCurve($('#chartEq'), state.eqParams);
        drawWave(
          $('#chartWave'),
          state.showingAfter
            ? (state.processedBuffer || state.originBuffer)
            : state.originBuffer,
          state.showingAfter ? C.terracotta : C.clay
        );
        if (state.arrangement) drawPiano($('#chartPiano'), state.arrangement.events);
      }, 180);
    });

    /* ---- 存盘触发点 ----
       跑完流水线的三处（体检 / 精修 / 渲染）各自在函数末尾调 scheduleSave，
       这里只补用户改参数的控件。input 会冒泡，EQ 十个滑块监听容器一次就够。 */
    const bump = () => scheduleSave();
    ['#strength', '#bpmRange', '#barsRange', '#eqBands'].forEach((s) => {
      const el = $(s);
      if (el) el.addEventListener('input', bump);
    });
    ['#modeSelect', '#tracks'].forEach((s) => {
      const el = $(s);
      if (el) el.addEventListener('click', bump);
    });

    $('#btnClearWs').addEventListener('click', async () => {
      if (Store) await Store.clear();
      location.reload();
    });

    // 切走 / 关页面前把去重窗口里那笔落下去。切标签页是常态，
    // 只靠 400ms 定时器的话，用户改完立刻切走就会丢最后一次改动。
    // pagehide 是尽力而为：已经开始的 IndexedDB 事务通常能写完。
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushSave();
    });
    window.addEventListener('pagehide', () => flushSave());
  }

  /* ---------- 启动 ---------- */
  function init() {
    initScroll();
    buildEqBands();
    buildModeSelect();
    renderTracks(null);
    drawEqCurve($('#chartEq'), state.eqParams);
    // 辅助技术感知：状态文本播报、波形切换按钮的按下态
    ['#heroStatusText', '#dropStatus'].forEach((s) => {
      const el = $(s);
      if (el && !el.hasAttribute('aria-live')) el.setAttribute('aria-live', 'polite');
    });
    const btnExportProfile = $('#btnExportProfile');
    if (btnExportProfile) btnExportProfile.disabled = true; // 空态禁用，体检后启用
    const btnScorePngInit = $('#btnScorePng');
    if (btnScorePngInit) btnScorePngInit.disabled = true;   // 没谱可导时同样禁用
    const btnScoreXmlInit = $('#btnScoreXml');
    if (btnScoreXmlInit) btnScoreXmlInit.disabled = true;
    drawLoudCurve($('#chartLoudCurve'));   // 空态提示先画上（体检后覆盖）
    setWaveView(false); // 初始 chip 选中态与「尚未精修」一致（HTML 默认高亮了「精修后」）
    bind();

    // ?static=1 直接显示全部内容（打印 / 截图 / 无障碍兜底）
    if (/[?&]static=1/.test(location.search)) {
      $$('.reveal').forEach((el) => el.classList.add('is-in'));
      document.documentElement.style.scrollBehavior = 'auto';
    }

    // ?demo=1 自动试跑示例，便于演示与验收
    if (/[?&]demo=1/.test(location.search)) {
      setTimeout(() => $('#btnDemo').click(), 400);
    }

    // 有存盘就把它接回来；?fresh=1 在 restoreWorkspace 里清库后直接返回
    restoreWorkspace();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else init();
})();
