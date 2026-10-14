const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto('http://127.0.0.1:8080/?static=1', { waitUntil: 'networkidle' });
  await page.click('#btnDemo');
  await page.waitForFunction(() => !document.querySelector('#checkBody').hidden, { timeout: 30000 });
  await page.waitForTimeout(600);
  await page.click('#btnProcess');
  await page.waitForFunction(() => document.querySelector('#btnProcess').textContent.includes('重新精修') || document.querySelector('#btnProcess').textContent.includes('失败'), { timeout: 30000 });
  await page.waitForTimeout(800);

  const info = await page.evaluate(() => {
    const cv = document.querySelector('#chartWave');
    const st = window.__state || null;
    const out = {
      hasCanvas: !!cv,
      cssW: cv && cv.clientWidth,
      cssH: cv && cv.clientHeight,
      bmpW: cv && cv.width,
      bmpH: cv && cv.height,
      parentW: cv && cv.parentElement && cv.parentElement.clientWidth,
    };
    // 读像素：有多少非透明点
    if (cv) {
      const ctx = cv.getContext('2d');
      const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let painted = 0, maxA = 0;
      for (let i = 3; i < img.length; i += 4) {
        if (img[i] > 8) painted++;
        if (img[i] > maxA) maxA = img[i];
      }
      out.paintedPx = painted;
      out.maxAlpha = maxA;
      out.totalPx = cv.width * cv.height;
    }
    return out;
  });
  console.log('canvas', JSON.stringify(info, null, 2));

  // 直接探测引擎 buffer
  const buf = await page.evaluate(async () => {
    const E = window.SonicEngine;
    const d = await E.synthesizeDemo();
    const ch = d.getChannelData(0);
    let peak = 0, rms = 0, nz = 0;
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i]);
      if (v > peak) peak = v;
      rms += ch[i] * ch[i];
      if (v > 1e-5) nz++;
    }
    return { len: ch.length, peak, rms: Math.sqrt(rms / ch.length), nonZeroFrac: nz / ch.length, sr: d.sampleRate };
  });
  console.log('demo buffer', JSON.stringify(buf, null, 2));

  await browser.close();
})();
