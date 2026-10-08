const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => console.log('CONSOLE', m.type(), m.text()));
  await page.goto('http://127.0.0.1:8080/?static=1', { waitUntil: 'networkidle' });
  await page.click('#btnDemo');
  await page.waitForFunction(() => !document.querySelector('#checkBody').hidden, { timeout: 30000 });
  await page.waitForTimeout(600);

  // 直接测 process 的输出
  const res = await page.evaluate(async () => {
    const E = window.SonicEngine;
    const src = await E.synthesizeDemo();
    const out = await E.process(src, {
      highpass: 30, eq: [0, .48, .18, 0, 0, 0, 0, 0, 0, 0],
      exciter: 0.3, denoise: 0.25, threshold: 0.35, ratio: 0.32, intensity: 0.55,
    });
    const d = out.getChannelData(0);
    let peak = 0, nz = 0, mn = 1, mx = -1;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a > 1e-6) nz++;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    // 模拟 drawWave 的 min/max
    const gw = 1000, step = Math.floor(d.length / gw);
    let visible = 0;
    for (let x = 0; x < gw; x++) {
      let lo = 1, hi = -1;
      for (let i = 0; i < step; i++) {
        const v = d[x * step + i] || 0;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (Math.abs(hi - lo) > 0.002) visible++;
    }
    return { len: d.length, peak, nonZero: nz, min: mn, max: mx, visibleCols: visible };
  });
  console.log('processed buffer', JSON.stringify(res, null, 2));

  await browser.close();
})();
