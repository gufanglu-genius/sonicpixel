/* 响度走势验收：卡片结构、曲线口径（3 秒短时窗）、原曲出图、
   精修叠加、平台目标切换、导出对齐后曲线靠拢目标、resize 重绘、
   既有功能只加不删（证据链 5 页签 / 五线谱卡）。
   用法：node tests/product/verify-loudcurve.js */
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';

(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('C:' + m.text()); });

  let pass = 0, fail = 0;
  const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ✓', name); }
    else { fail++; console.log('  ✗', name, extra != null ? JSON.stringify(extra) : ''); }
  };
  const inkOf = (sel) => p.evaluate((s) => {
    const cv = document.querySelector(s);
    if (!cv) return 0;
    const g = cv.getContext('2d');
    const img = g.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < img.length; i += 4) if (img[i] > 16) n++;
    return n;
  }, sel);

  await p.goto('http://127.0.0.1:8080/?fresh=1&synth=1', { waitUntil: 'networkidle' });

  // ① 结构（体检前：空态 + 只加不删）
  console.log('① 结构');
  const dom = await p.evaluate(() => ({
    card: !!document.getElementById('loudCurveCard'),
    canvas: !!document.getElementById('chartLoudCurve'),
    legend: [...document.querySelectorAll('#loudCurveCard .legend-item')]
      .map((e) => e.textContent.trim()),
    note: (document.getElementById('loudCurveNote') || {}).textContent || '',
    chips: document.querySelectorAll('#evTabs .chip').length,
    scoreStill: !!document.getElementById('scoreCard') &&
      !!document.getElementById('btnScorePng') &&
      !!document.getElementById('btnScoreXml'),
  }));
  ok(dom.card && dom.canvas, '卡片与画布在位');
  ok(dom.legend.join('/') === '原曲/精修后/平台目标', '图例三项', dom.legend);
  ok(/3 秒短时窗/.test(dom.note), '口径诚实声明在位');
  ok(dom.chips === 0 || dom.chips === 5, '证据链页签未被挤掉（0 或 5）', dom.chips);
  ok(dom.scoreStill, '五线谱卡片与两个导出按钮仍在');
  const emptyInk = await inkOf('#chartLoudCurve');
  ok(emptyInk > 50, '空态提示已绘制', emptyInk);

  // ② demo 体检 → 原曲曲线
  await p.click('#btnDemo');
  await p.waitForFunction(() =>
    document.querySelectorAll('#evTabs .chip').length === 5 &&
    window.__state.loudCurve && window.__state.loudCurve.orig
  , null, { timeout: 90000 });
  console.log('② 原曲曲线');
  const orig = await p.evaluate(() => {
    const c = window.__state.loudCurve.orig;
    const v = Array.from(c.lufs);
    return {
      n: v.length,
      win: c.windowSec,
      hop: c.hopSec,
      min: Math.min(...v),
      max: Math.max(...v),
      finite: v.every(Number.isFinite),
    };
  });
  ok(orig.n > 10, '采样点 > 10', orig.n);
  ok(Math.abs(orig.win - 3) < 0.01, '短时窗 3 秒', orig.win);
  ok(Math.abs(orig.hop - 0.25) < 0.01, '步进 0.25 秒', orig.hop);
  ok(orig.finite && orig.max < 5 && orig.max > -30,
    '数值有限且落在响度量程内', { min: orig.min, max: orig.max });
  const ink1 = await inkOf('#chartLoudCurve');
  ok(ink1 > 800, '原曲曲线已出图（墨迹像素）', ink1);

  // ③ 切平台目标 → 状态落位（目标线随重画）
  console.log('③ 平台目标');
  await p.click('[data-lufs-target="spotify"]');
  const tgt = await p.evaluate(() => window.__state.lufsTarget);
  ok(tgt === 'spotify', '切到 Spotify −14', tgt);

  // ④ 精修 → 叠加精修后曲线
  console.log('④ 精修叠加');
  await p.click('#btnProcess');
  await p.waitForFunction(() =>
    window.__state.processedBuffer &&
    window.__state.loudCurve && window.__state.loudCurve.proc
  , null, { timeout: 90000 });
  const both = await p.evaluate(() => {
    const lc = window.__state.loudCurve;
    const a = Array.from(lc.orig.lufs);
    const c = Array.from(lc.proc.lufs);
    let maxDiff = 0;
    for (let i = 0; i < Math.min(a.length, c.length); i++) {
      maxDiff = Math.max(maxDiff, Math.abs(a[i] - c[i]));
    }
    return { on: a.length, pn: c.length, maxDiff };
  });
  ok(both.pn > 10, '精修后曲线采样点 > 10', both.pn);
  ok(both.pn === both.on, '两条曲线同长（同素材同时基）', both);
  ok(both.maxDiff > 0.05, '两曲线确实不同（精修改动可见）', both.maxDiff);
  const ink2 = await inkOf('#chartLoudCurve');
  ok(ink2 > ink1, '叠加后墨迹增多', { ink1, ink2 });

  // ⑤ 导出对齐。定量断言用 EBU −23（本素材精修后峰值已到 −0.3 dBFS，
  //    常数增益对齐到 −14 会被峰值 −1 顶线封顶——那是既有设计的如实上报，
  //    单独在 ⑤b 用不变式锁「不超标」）。EBU −23 只需 −2 dB 增益，顶线够用。
  console.log('⑤ 导出对齐');
  await p.click('[data-lufs-target="ebu"]');
  const dl = p.waitForEvent('download', { timeout: 30000 }).catch(() => null);
  await p.click('#btnExportProcessed');
  const d = await dl;
  ok(!!d, '导出触发下载');
  const aligned = await p.evaluate(() => {
    const lc = window.__state.loudCurve;
    const mean = (c) => {
      if (!c) return NaN;
      const v = Array.from(c.lufs).filter((x) => x > -60);   // 忽略静音窗
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
    };
    const st = window.__state;
    return {
      origMean: mean(lc.orig),
      procMean: mean(lc.proc),
      procInt: st.lufs && st.lufs.proc ? st.lufs.proc.lufs : null,
    };
  });
  ok(aligned.procInt != null && Math.abs(aligned.procInt - (-23)) <= 1.0,
    '积分响度对齐到 −23±1（EBU 目标）', aligned.procInt);
  ok(Math.abs(aligned.procMean - (-23)) <=
     Math.abs(aligned.origMean - (-23)) + 0.75,
    '短时曲线均值向目标靠拢', aligned);

  // ⑤b 峰值顶线不变式：换回 Spotify −14（该素材必被顶线封顶），
  //    实测永远不高于目标——宁可不达成，绝不虚报超标
  await p.click('[data-lufs-target="spotify"]');
  const dl2 = p.waitForEvent('download', { timeout: 30000 }).catch(() => null);
  await p.click('#btnExportProcessed');
  await dl2;
  const ceiling = await p.evaluate(() => {
    const st = window.__state;
    return st.lufs && st.lufs.proc ? st.lufs.proc.lufs : null;
  });
  ok(ceiling != null && ceiling <= -14 + 1.5,
    '峰值受限时不虚报：实测 ≤ 目标 +1.5', ceiling);

  // ⑥ resize → 重绘非空
  console.log('⑥ resize 重绘');
  await p.setViewportSize({ width: 900, height: 900 });
  await p.waitForTimeout(500);
  const ink3 = await inkOf('#chartLoudCurve');
  ok(ink3 > 800, 'resize 后曲线重绘非空', ink3);

  ok(errs.length === 0, '无页面错误', errs.slice(0, 3));
  await b.close();
  console.log(`\nverify-loudcurve: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
