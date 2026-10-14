// Scenario 4: current-build real song + chroma highlight + modeOk false-pass + mobile
const { launch, installBlobCapture, grabBlobs, text, waitIdleBtn } = require('./rt-common');

(async () => {
  const { browser, page, logs } = await launch();
  await installBlobCapture(page);
  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);

  console.log('=== A. 红头绳 current build ===');
  await page.setInputFiles('#fileInput', '/Users/chenhuidediannao/Downloads/红头绳.wav');
  await page.waitForFunction(() => !document.querySelector('#checkBody').hidden, { timeout: 240000 });
  await page.waitForTimeout(400);
  const metrics = {};
  for (const id of ['mBpm', 'mMeter', 'mThd', 'mLra', 'mCent', 'mCrest']) metrics[id] = await text(page, '#' + id);
  console.log('METRICS', JSON.stringify(metrics));
  console.log('MODE', await text(page, '#modeGlyph'), await text(page, '#modeName'),
    '| chips', (await text(page, '#modeChips'))?.replace(/\s+/g, ' '));
  console.log('STRUCTURE', (await text(page, '#structureLegend'))?.replace(/\s+/g, ' '));
  await page.click('#btnProcess');
  await waitIdleBtn(page, '#btnProcess', '重新精修|失败', 240000);
  console.log('waveNote after process:', await text(page, '#waveNote'));

  console.log('=== B. export profile shape (current) ===');
  await page.click('#btnExportProfile');
  await page.waitForTimeout(400);
  let blobs = await grabBlobs(page);
  const prof = blobs.find((b) => b.type.includes('json') && b.text);
  if (prof) {
    const j = JSON.parse(prof.text);
    console.log('meta:', JSON.stringify(j.meta));
    console.log('identity:', JSON.stringify(j.identity));
    console.log('quality keys:', Object.keys(j.quality), 'vals:', JSON.stringify({ ...j.quality }));
    console.log('timbre:', JSON.stringify(j.timbre));
    console.log('structure n:', j.structure.length, JSON.stringify(j.structure.map((s) => s.section + '@' + s.start + '-' + s.end)));
    console.log('melody keys:', Object.keys(j.melody || {}));
    console.log('provenance:', JSON.stringify(j.provenance));
  }

  console.log('=== C. chroma highlight with 蜕变日 (C 商) ===');
  await page.setInputFiles('#fileInput', '/Users/chenhuidediannao/Downloads/蜕变日.wav');
  await page.waitForFunction(() => /蜕变日/.test(document.querySelector('#heroStatusText').textContent), { timeout: 240000 });
  await page.waitForTimeout(400);
  console.log('MODE2', await text(page, '#modeGlyph'), await text(page, '#modeName'),
    '| chips', (await text(page, '#modeChips'))?.replace(/\s+/g, ' '));
  const chroma = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.chroma-row')).map((r) =>
      (r.classList.contains('is-scale') ? '[' + r.querySelector('.chroma-name').textContent + ']' : r.querySelector('.chroma-name').textContent)
    ).join(' ')
  );
  console.log('CHROMA-HL (brackets = highlighted):', chroma);
  console.log('STRUCTURE2', (await text(page, '#structureLegend'))?.replace(/\s+/g, ' '));

  console.log('=== D. modeOk false-pass attempt: render, mute bass/harm, render 羽 ===');
  await page.click('#btnRender');
  await waitIdleBtn(page, '#btnRender', '重新渲染|失败', 90000);
  // mute bass + harm + drums (keep lead/pad), select 羽, re-render
  await page.evaluate(() => {
    document.querySelectorAll('.track').forEach((t) => {
      if (['bass', 'harm', 'drums'].includes(t.dataset.track)) t.querySelector('.track-btn').click();
    });
    const chips = Array.from(document.querySelectorAll('#modeSelect .chip'));
    chips[4].click();
  });
  await page.click('#btnRender');
  await waitIdleBtn(page, '#btnRender', '重新渲染|失败', 90000);
  await page.click('#btnRecheck');
  await page.waitForTimeout(1300);
  const checks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.check')).map((c) => ({
      cls: c.className, name: c.querySelector('.check-name')?.textContent,
      value: c.querySelector('.check-value')?.textContent, note: c.querySelector('p')?.textContent,
    }))
  );
  console.log('CHECKS', JSON.stringify(checks, null, 1));
  console.log('provenance after recheck:', (await text(page, '#tree'))?.replace(/\s+/g, ' ').slice(0, 400));

  console.log('LOGS-A', JSON.stringify(logs));
  await browser.close();

  // ===== E. 390px mobile full chain =====
  const m = await launch({ viewport: { width: 390, height: 844 } });
  await installBlobCapture(m.page);
  await m.page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
  await m.page.waitForTimeout(400);
  await m.page.click('#btnDemo');
  await m.page.waitForFunction(() => !document.querySelector('#checkBody').hidden, { timeout: 60000 });
  await m.page.waitForTimeout(400);
  await m.page.click('#btnProcess');
  await waitIdleBtn(m.page, '#btnProcess', '重新精修|失败', 90000);
  await m.page.click('#btnRender');
  await waitIdleBtn(m.page, '#btnRender', '重新渲染|失败', 90000);
  await m.page.click('#btnRecheck');
  await m.page.waitForTimeout(1000);
  const overflow = await m.page.evaluate(() => {
    const de = document.documentElement;
    const wide = [];
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > de.clientWidth + 2 && el.offsetParent !== null) {
        wide.push((el.id || el.className || el.tagName) + ':' + Math.round(r.width));
      }
    });
    return { scrollW: de.scrollWidth, clientW: de.clientWidth, wide: wide.slice(0, 12) };
  });
  console.log('MOBILE overflow:', JSON.stringify(overflow));
  await m.page.click('#btnExportProfile');
  await m.page.waitForTimeout(300);
  const mb = await grabBlobs(m.page);
  console.log('MOBILE blobs:', JSON.stringify(mb.map((b) => b.type + ':' + b.size)));
  console.log('MOBILE status:', await text(m.page, '#heroStatusText'));
  console.log('LOGS-M', JSON.stringify(m.logs));
  await m.browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
