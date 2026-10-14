// Scenario 2: real 155s song (红头绳.wav) full chain + second import residue
const { launch, installBlobCapture, grabBlobs, text, waitIdleBtn } = require('./rt-common');

const F1 = '/Users/chenhuidediannao/Downloads/红头绳.wav';
const F2 = '/Users/chenhuidediannao/Downloads/蜕变日.wav';

(async () => {
  const { browser, page, logs } = await launch();
  await installBlobCapture(page);
  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  console.log('=== import', F1, '===');
  const t0 = Date.now();
  await page.setInputFiles('#fileInput', F1);
  await page.waitForFunction(() => !document.querySelector('#checkBody').hidden, { timeout: 240000 });
  await page.waitForTimeout(500);
  console.log('import took', (Date.now() - t0) / 1000, 's');

  const metrics = {};
  for (const id of ['mBpm', 'mMeter', 'mDur', 'mSr', 'mThd', 'mLra', 'mCent', 'mCrest']) {
    metrics[id] = await text(page, '#' + id);
  }
  console.log('METRICS', JSON.stringify(metrics));
  console.log('STATUS', await text(page, '#heroStatusText'));
  console.log('MODE', await text(page, '#modeGlyph'), await text(page, '#modeName'));
  console.log('MODECHIPS', (await text(page, '#modeChips'))?.replace(/\s+/g, ' '));
  const legend = await text(page, '#structureLegend');
  console.log('STRUCTURE', legend && legend.replace(/\s+/g, ' '));
  // chroma highlight check
  const chroma = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.chroma-row')).map((r) => ({
      pc: r.querySelector('.chroma-name')?.textContent,
      scale: r.classList.contains('is-scale'),
    }))
  );
  console.log('CHROMA-HL', JSON.stringify(chroma));
  // EQ bands preset check (centroid bug: 8k/4k bands)
  const eqBands = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.eq-band')).map((b) => ({
      f: b.querySelector('.eq-band-label')?.textContent,
      v: b.querySelector('.eq-band-val')?.textContent,
    }))
  );
  console.log('EQ', JSON.stringify(eqBands));
  console.log('PRESCRIPTION', (await text(page, '#prescription'))?.replace(/\s+/g, ' ').slice(0, 360));

  console.log('=== process ===');
  const t1 = Date.now();
  await page.click('#btnProcess');
  await waitIdleBtn(page, '#btnProcess', '重新精修|失败', 240000);
  console.log('process took', (Date.now() - t1) / 1000, 's');
  console.log('waveNote:', await text(page, '#waveNote'));

  console.log('=== render ===');
  await page.click('#btnRender');
  await waitIdleBtn(page, '#btnRender', '重新渲染|失败', 120000);
  console.log('status:', await text(page, '#heroStatusText'));

  console.log('=== recheck ===');
  await page.click('#btnRecheck');
  await page.waitForTimeout(1300);
  const checks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.check')).map((c) => ({
      cls: c.className,
      name: c.querySelector('.check-name')?.textContent,
      value: c.querySelector('.check-value')?.textContent,
      note: c.querySelector('p')?.textContent,
    }))
  );
  console.log('CHECKS', JSON.stringify(checks, null, 1));

  console.log('=== export profile (after render) ===');
  await page.click('#btnExportProfile');
  await page.waitForTimeout(500);
  let blobs = await grabBlobs(page);
  const prof = blobs.find((b) => b.type.includes('json') && b.text);
  if (prof) {
    const j = JSON.parse(prof.text);
    console.log('meta:', JSON.stringify(j.meta));
    console.log('identity:', JSON.stringify(j.identity));
    console.log('thd:', j.quality.thd, 'thdCoverage?', j.quality.thd_coverage, 'lra:', j.quality.lra);
    console.log('quality.spectral:', JSON.stringify(j.quality.spectral), ' timbre:', JSON.stringify(j.timbre));
    console.log('structure n=', j.structure?.length, JSON.stringify(j.structure));
    console.log('melody keys:', Object.keys(j.melody || {}), 'contour len', j.melody?.contour?.length,
      'range', j.melody?.rangeSemitones, 'noteCount', j.melody?.noteCount,
      'rhythmNgram sample', JSON.stringify(j.melody?.rhythmNgram?.slice(0, 10)));
    console.log('provenance:', JSON.stringify(j.provenance));
    console.log('source_file present?', 'source_file' in (j.meta || {}));
  } else console.log('NO JSON BLOB', JSON.stringify(blobs.map((b) => b.type + ':' + b.size)));

  console.log('=== import second file (residue check) ===');
  await page.setInputFiles('#fileInput', F2);
  await page.waitForFunction(
    (prev) => (document.querySelector('#heroStatusText') || {}).textContent !== prev,
    await text(page, '#heroStatusText'),
    { timeout: 240000 }
  );
  await page.waitForFunction(() => /体检完成/.test(document.querySelector('#heroStatusText').textContent), { timeout: 240000 });
  await page.waitForTimeout(400);
  console.log('STATUS2', await text(page, '#heroStatusText'));
  console.log('METRICS2 mDur', await text(page, '#mDur'), 'mThd', await text(page, '#mThd'), 'mBpm', await text(page, '#mBpm'));
  console.log('TREE2', (await text(page, '#tree'))?.replace(/\s+/g, ' '));
  const ab = await page.evaluate(() => {
    const b = document.querySelector('#btnAB');
    return { disabled: b.disabled, text: b.textContent };
  });
  console.log('btnAB after re-import:', JSON.stringify(ab));
  console.log('waveNote after re-import:', await text(page, '#waveNote'));
  const chips = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.chip[data-wave]')).map((c) => ({ w: c.dataset.wave, active: c.classList.contains('is-active') }))
  );
  console.log('wave chips:', JSON.stringify(chips));
  const tracksText = (await text(page, '#tracks'))?.replace(/\s+/g, ' ');
  console.log('TRACKS after re-import (stale?)', tracksText?.slice(0, 200));
  const pianoBlank = await page.evaluate(() => {
    const cv = document.querySelector('#chartPiano');
    const ctx = cv.getContext('2d');
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let painted = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
    return painted;
  });
  console.log('chartPiano painted pixels after re-import:', pianoBlank);

  console.log('=== export MIDI after re-import (stale arrangement?) ===');
  await page.click('#btnExportMidi');
  await page.waitForTimeout(400);
  blobs = await grabBlobs(page);
  console.log('blobs now:', JSON.stringify(blobs.map((b) => b.type + ':' + b.size)));

  console.log('LOGS', JSON.stringify(logs, null, 1));
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
