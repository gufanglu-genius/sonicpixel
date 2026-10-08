// Scenario 1: demo audio full chain
const { launch, installBlobCapture, grabBlobs, text, waitIdleBtn } = require('./rt-common');

(async () => {
  const { browser, page, logs } = await launch();
  await installBlobCapture(page);
  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  console.log('--- click demo ---');
  await page.click('#btnDemo');
  await page.waitForFunction(() => !document.querySelector('#checkBody').hidden, { timeout: 60000 });
  await page.waitForTimeout(800);

  const metrics = {};
  for (const id of ['mBpm', 'mMeter', 'mDur', 'mSr', 'mThd', 'mLra', 'mCent', 'mCrest']) {
    metrics[id] = await text(page, '#' + id);
  }
  console.log('METRICS', JSON.stringify(metrics, null, 1));
  console.log('STATUS', await text(page, '#heroStatusText'));
  console.log('MODE', await text(page, '#modeGlyph'), await text(page, '#modeName'));
  console.log('MODECHIPS', (await text(page, '#modeChips'))?.replace(/\s+/g, ' '));
  const legend = await text(page, '#structureLegend');
  console.log('STRUCTURE', legend && legend.replace(/\s+/g, ' '));
  console.log('PRESCRIPTION', (await text(page, '#prescription'))?.replace(/\s+/g, ' ').slice(0, 400));

  // --- process ---
  console.log('--- process ---');
  await page.click('#btnProcess');
  await waitIdleBtn(page, '#btnProcess', '重新精修|失败', 90000);
  console.log('btnProcess:', await text(page, '#btnProcess'));
  console.log('waveNote:', await text(page, '#waveNote'));
  console.log('status:', await text(page, '#heroStatusText'));

  // --- double click process/render race (after done) ---
  console.log('--- double-click render ---');
  await page.click('#btnRender');
  await page.click('#btnRender', { force: true }).catch((e) => console.log('second render click:', e.message));
  await waitIdleBtn(page, '#btnRender', '重新渲染|失败', 90000);
  await page.waitForTimeout(500);
  console.log('btnRender:', await text(page, '#btnRender'));
  console.log('status:', await text(page, '#heroStatusText'));
  console.log('TRACKS', (await text(page, '#tracks'))?.replace(/\s+/g, ' ').slice(0, 300));

  // --- recheck ---
  console.log('--- recheck ---');
  await page.click('#btnRecheck');
  await page.waitForTimeout(1200);
  const checks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.check')).map((c) => ({
      cls: c.className,
      name: c.querySelector('.check-name')?.textContent,
      value: c.querySelector('.check-value')?.textContent,
      note: c.querySelector('p')?.textContent,
    }))
  );
  console.log('CHECKS', JSON.stringify(checks, null, 1));
  console.log('status:', await text(page, '#heroStatusText'));

  // --- exports ---
  console.log('--- export profile ---');
  await page.click('#btnExportProfile');
  await page.waitForTimeout(400);
  let blobs = await grabBlobs(page);
  console.log('BLOBS after profile:', JSON.stringify(blobs.map((b) => ({ type: b.type, size: b.size, name: b.name }))));
  const prof = blobs.find((b) => b.type.includes('json') && b.text);
  if (prof) {
    const j = JSON.parse(prof.text);
    console.log('PROFILE.meta', JSON.stringify(j.meta));
    console.log('PROFILE.identity', JSON.stringify(j.identity));
    console.log('PROFILE.quality', JSON.stringify({ ...j.quality, spectral: j.quality.spectral }));
    console.log('PROFILE.timbre', JSON.stringify(j.timbre));
    console.log('PROFILE.melody keys', Object.keys(j.melody), 'contour len', j.melody.contour?.length,
      'contour sample', JSON.stringify(j.melody.contour?.slice(0, 12)),
      'rhythmNgram', JSON.stringify(j.melody.rhythmNgram?.slice(0, 12)),
      'range', j.melody.rangeSemitones);
    console.log('PROFILE.structure', JSON.stringify(j.structure));
    console.log('PROFILE.provenance', JSON.stringify(j.provenance));
    console.log('spectral === timbre ?', JSON.stringify(j.quality.spectral) === JSON.stringify(j.timbre));
  }

  console.log('--- export midi + stems ---');
  await page.click('#btnExportMidi');
  await page.click('#btnExportStems');
  await page.waitForTimeout(500);
  blobs = await grabBlobs(page);
  console.log('ALL BLOBS', JSON.stringify(blobs.map((b) => ({ type: b.type, size: b.size, name: b.name }))));

  // version tree
  console.log('TREE', (await text(page, '#tree'))?.replace(/\s+/g, ' '));

  console.log('LOGS', JSON.stringify(logs, null, 1));
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
