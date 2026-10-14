const { launch, installBlobCapture, grabBlobs, text, waitIdleBtn } = require('./rt-common');
(async () => {
  const { browser, page, logs } = await launch();
  await installBlobCapture(page);
  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);

  console.log('=== A. recheck in truly empty state ===');
  await page.click('#btnRecheck');
  await page.waitForTimeout(400);
  console.log('status:', JSON.stringify(await text(page, '#heroStatusText')));

  console.log('=== B. demo import then recheck before process/render ===');
  await page.click('#btnDemo');
  await page.waitForFunction(() => !document.querySelector('#checkBody').hidden, { timeout: 60000 });
  await page.waitForTimeout(300);
  const m = {};
  for (const id of ['mBpm','mMeter','mThd','mLra','mCent','mCrest','mDur']) m[id] = await text(page, '#' + id);
  console.log('METRICS', JSON.stringify(m));
  const eq = await page.evaluate(() => Array.from(document.querySelectorAll('.eq-band')).map(b => b.querySelector('.eq-band-label').textContent + '=' + b.querySelector('.eq-band-val').textContent));
  console.log('EQ', JSON.stringify(eq));
  await page.click('#btnRecheck');
  await page.waitForTimeout(500);
  console.log('status after recheck:', JSON.stringify(await text(page, '#heroStatusText')));
  console.log('checks:', JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('.check')).map(c => c.className + '|' + (c.querySelector('.check-value')||{}).textContent))));

  console.log('=== C. process then recheck (processed-only) + THD delta ===');
  await page.click('#btnProcess');
  await waitIdleBtn(page, '#btnProcess', '重新精修|失败', 90000);
  console.log('waveNote:', JSON.stringify(await text(page, '#waveNote')));
  await page.click('#btnRecheck');
  await page.waitForTimeout(1200);
  console.log('checks after process:', JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('.check')).map(c => ({cls:c.className, v:(c.querySelector('.check-value')||{}).textContent, n:(c.querySelector('p')||{}).textContent}))), null, 1));

  console.log('=== D. render then export profile identity vs UI ===');
  await page.click('#btnRender');
  await waitIdleBtn(page, '#btnRender', '重新渲染|失败', 90000);
  await page.click('#btnRecheck');
  await page.waitForTimeout(1200);
  console.log('checks after render:', JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('.check')).map(c => ({cls:c.className, v:(c.querySelector('.check-value')||{}).textContent, n:(c.querySelector('p')||{}).textContent}))), null, 1));
  const uiBpm = await text(page, '#mBpm'), uiDur = await text(page, '#mDur');
  await page.click('#btnExportProfile');
  await page.waitForTimeout(400);
  const blobs = await grabBlobs(page);
  const prof = blobs.find(b => b.type.includes('json') && b.text);
  if (prof) {
    const j = JSON.parse(prof.text);
    console.log('EXPORT meta:', JSON.stringify(j.meta));
    console.log('EXPORT identity:', JSON.stringify(j.identity));
    console.log('UI mBpm/mDur:', uiBpm, uiDur);
    console.log('EXPORT structure n:', (j.structure||[]).length);
  }

  console.log('=== E. MIDI tempo bytes vs slider ===');
  await page.evaluate(() => { const r = document.querySelector('#bpmRange'); r.value = '132'; r.dispatchEvent(new Event('input', {bubbles:true})); });
  const midiBytes = await page.evaluate(async () => {
    const saved = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { saved.push(blob); return orig(blob); };
    document.querySelector('#btnExportMidi').click();
    await new Promise(r => setTimeout(r, 250));
    URL.createObjectURL = orig;
    const b = saved[0]; if (!b) return null;
    const v = new Uint8Array(await b.arrayBuffer());
    for (let i = 0; i < v.length - 5; i++) {
      if (v[i] === 0xff && v[i+1] === 0x51 && v[i+2] === 0x03) {
        const tempo = (v[i+3] << 16) | (v[i+4] << 8) | v[i+5];
        return { tempo, bpmFromTempo: Math.round(60000000/tempo*10)/10, size: v.length };
      }
    }
    return { tempo: null, size: v.length };
  });
  console.log('MIDI:', JSON.stringify(midiBytes));

  console.log('=== F. chip click waveNote staleness ===');
  await page.click('.chip[data-wave="before"]');
  await page.waitForTimeout(150);
  console.log('waveNote after 原始 chip:', JSON.stringify(await text(page, '#waveNote')));

  console.log('LOGS', JSON.stringify(logs, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
