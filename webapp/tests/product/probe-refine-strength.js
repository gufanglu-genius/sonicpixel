/* L2 精修「改动量」量化探针：原始 vs 精修 的可闻差异指标
   指标：响度对齐后的波形差分比、分带能量差(Goertzel)、LRA、峰性比、频谱重心
   用法：node tests/product/probe-refine-strength.js [strength=55]
   只测不判：打印等响对齐后的分带差/动态/重心，不设退出门槛
   （数值随素材变，设硬线会脆） */
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const STRENGTH = Number(process.argv[2] || 55);

(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto('http://127.0.0.1:8080/?fresh=1&synth=1', { waitUntil: 'networkidle' });
  await p.click('#btnDemo');
  await p.waitForFunction(() =>
    document.querySelectorAll('#sourceKind .chip').length === 2 &&
    document.querySelectorAll('#evTabs .chip').length === 5
  , null, { timeout: 90000 });

  const r = await p.evaluate(async (strength) => {
    const E = window.SonicEngine;
    const st = window.__state;
    const o = st.originBuffer;
    const q = st.profile && st.profile.quality;
    const expand = Math.min(1, Math.max(0, (11 - (q && q.lra || 0)) / 11));
    const params = {
      highpass: 30,
      eq: Array.from(st.eqParams || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      exciter: 0.3, denoise: 0.25, threshold: 0.35, ratio: 0.32,
      intensity: strength / 100,
      kind: st.material || 'ai',
      notches: Array.from(st.notches || []),
      expand,
    };
    const proc = await E.process(o, params);

    const peakOf = (buf) => {
      let pk = 0;
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const ch = buf.getChannelData(c);
        for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > pk) pk = a; }
      }
      return pk;
    };

    // 响度对齐后再差分：排除「只是变响了」的假改动
    const lo = E.measureLoudness(o), lp = E.measureLoudness(proc);
    const g = (lo.lufs != null && lp.lufs != null) ? Math.pow(10, (lo.lufs - lp.lufs) / 20) : 1;
    const n = Math.min(o.length, proc.length);
    let diff = 0, base = 0;
    const oc = o.getChannelData(0), pc = proc.getChannelData(0);
    for (let i = 0; i < n; i++) { const d = pc[i] * g - oc[i]; diff += d * d; base += oc[i] * oc[i]; }
    const diffRatio = Math.sqrt(diff / Math.max(1e-12, base));

    // Goertzel 分带：响度对齐后各中心频率的能量差（dB），看改动落在哪
    const centers = [60, 150, 400, 1000, 2500, 6000, 12000];
    // Goertzel 全长算（抽样会破坏频率映射）；g 把 proc 拉回原曲响度后比能量
    const goer = (ch, sr, f0, len) => {
      const w = 2 * Math.PI * f0 / sr;
      const cw = 2 * Math.cos(w);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < len; i++) {
        const s0 = ch[i] + cw * s1 - s2;
        s2 = s1; s1 = s0;
      }
      return s1 * s1 + s2 * s2 - cw * s1 * s2;
    };
    const bandDb = centers.map((f) => {
      const a = goer(oc, o.sampleRate, f, n);
      const bd = goer(pc, proc.sampleRate, f, n);
      const ra = a, rb = bd * g * g;
      return +(10 * Math.log10((rb + 1e-18) / (ra + 1e-18))).toFixed(2);
    });

    const an = E.analyze(proc);
    const cen = (pr) => (pr.timbre && pr.timbre.centroid) || 0;
    return {
      strength,
      diffRatio: +diffRatio.toFixed(4),
      bandDb,   // 60/150/400/1k/2.5k/6k/12k Hz 精修相对原曲（等响后）dB
      lufsOrig: lo.lufs, lufsProc: lp.lufs,
      gainApplied: +(20 * Math.log10(g)).toFixed(2),
      lraOrig: q && q.lra, lraProc: an.quality.lra,
      crestOrig: q && q.crest, crestProc: an.quality.crest,
      centroidOrig: cen(st.profile), centroidProc: cen(an),
      peakOrig: +peakOf(o).toFixed(3), peakProc: +peakOf(proc).toFixed(3),
      expand,
      eq: params.eq, notches: params.notches.length,
    };
  }, STRENGTH);

  console.log(JSON.stringify(r, null, 1));
  await b.close();
})();
