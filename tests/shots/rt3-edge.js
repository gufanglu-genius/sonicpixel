// Scenario 3: edge cases on current build
const { launch, installBlobCapture, grabBlobs, text, waitIdleBtn } = require('./rt-common');

(async () => {
  const { browser, page, logs } = await launch();
  await installBlobCapture(page);
  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  console.log('=== EMPTY STATE EXPORTS ===');
  const statusBefore = await text(page, '#heroStatusText');
  await page.click('#btnExportProfile');
  await page.waitForTimeout(300);
  console.log('profile: status', JSON.stringify(await text(page, '#heroStatusText')), 'changed?', (await text(page, '#heroStatusText')) !== statusBefore);
  await page.click('#btnExportMidi');
  await page.waitForTimeout(200);
  console.log('midi: status', JSON.stringify(await text(page, '#heroStatusText')));
  await page.click('#btnExportStems');
  await page.waitForTimeout(200);
  console.log('stems: status', JSON.stringify(await text(page, '#heroStatusText')));
  let blobs = await grabBlobs(page);
  console.log('empty-state blobs:', JSON.stringify(blobs.map((b) => b.type + ':' + b.size)));

  console.log('=== RAPID DOUBLE-CLICK DEMO x3 ===');
  await page.click('#btnDemo');
  await page.click('#btnDemo', { force: true }).catch(() => {});
  await page.click('#btnHeroDemo', { force: true }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('#checkBody').hidden, { timeout: 60000 });
  await page.waitForTimeout(2500);
  const tree1 = (await text(page, '#tree'))?.replace(/\s+/g, ' ');
  console.log('TREE after rapid demo x3:', tree1);
  console.log('status:', await text(page, '#heroStatusText'));

  console.log('=== EQ PRESET (demo centroid ~200Hz → expect 4k/8k preset if q.centroid worked) ===');
  const eqBands = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.eq-band')).map((b) => b.querySelector('.eq-band-label').textContent + '=' + b.querySelector('.eq-band-val').textContent)
  );
  console.log('EQ', JSON.stringify(eqBands));
  console.log('mCent', await text(page, '#mCent'), 'mThd', await text(page, '#mThd'));

  console.log('=== L2 distortion injection: pure 440Hz sine, analyze → process → analyze ===');
  const sineTest = await page.evaluate(async () => {
    const sr = 44100;
    const ctx = new OfflineAudioContext(1, sr * 3, sr);
    const o = ctx.createOscillator();
    o.type = 'sine'; o.frequency.value = 440;
    const g = ctx.createGain(); g.gain.value = 0.5;
    o.connect(g); g.connect(ctx.destination); o.start(0);
    const buf = await ctx.startRendering();
    const a = SonicEngine.analyze(buf);
    const out = await SonicEngine.process(buf, { eq: new Array(10).fill(0), intensity: 0.55 });
    const b = SonicEngine.analyze(out);
    return {
      before: { thd: a.quality.thd, thdCoverage: a.quality.thdCoverage, crest: a.quality.crest, peak: a.quality.peak },
      after: { thd: b.quality.thd, thdCoverage: b.quality.thdCoverage, crest: b.quality.crest, peak: b.quality.peak },
    };
  });
  console.log('SINE', JSON.stringify(sineTest));

  console.log('=== PROCESS demo: thd before/after ===');
  const procNote0 = await text(page, '#waveNote');
  await page.click('#btnProcess');
  await waitIdleBtn(page, '#btnProcess', '重新精修|失败', 90000);
  console.log('waveNote before:', procNote0, '| after:', await text(page, '#waveNote'));

  console.log('=== wave chip click (note staleness) ===');
  await page.click('.chip[data-wave="before"]');
  await page.waitForTimeout(150);
  console.log('after clicking 原始 chip, waveNote =', JSON.stringify(await text(page, '#waveNote')));

  console.log('=== RENDER with 羽 selected → recheck modeOk repro ===');
  await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll('#modeSelect .chip'));
    chips[4].click(); // 羽
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
  console.log('CHECKS(yu)', JSON.stringify(checks, null, 1));

  console.log('=== BPM slider desync → MIDI tempo ===');
  await page.evaluate(() => {
    const r = document.querySelector('#bpmRange');
    r.value = '132';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#btnExportMidi');
  await page.waitForTimeout(300);
  blobs = await grabBlobs(page);
  const midi = blobs.filter((b) => b.type.includes('midi')).pop();
  if (midi) {
    // parse tempo from text? blobs only store text for json. Need byte access — re-export with capture
  }
  const tempoInfo = await page.evaluate(async () => {
    // re-run export path: build midi from current state via clicking is done; instead call engine directly is not enough.
    // Parse the last created object URL blob stored? We stored only type/size. Re-declare capture with bytes:
    return null;
  });
  console.log('midi blob after slider=132:', midi ? midi.type + ':' + midi.size : 'none');

  // capture MIDI bytes properly
  const midiBytes = await page.evaluate(async () => {
    const saved = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      saved.push(blob);
      return orig(blob);
    };
    document.querySelector('#btnExportMidi').click();
    await new Promise((r) => setTimeout(r, 200));
    URL.createObjectURL = orig;
    const b = saved[0];
    if (!b) return null;
    const ab = await b.arrayBuffer();
    const v = new Uint8Array(ab);
    // find FF 51 03 tempo
    for (let i = 0; i < v.length - 5; i++) {
      if (v[i] === 0xff && v[i + 1] === 0x51 && v[i + 2] === 0x03) {
        const tempo = (v[i + 3] << 16) | (v[i + 4] << 8) | v[i + 5];
        return { tempo, bpmFromTempo: 60000000 / tempo, size: v.length };
      }
    }
    return { tempo: null, size: v.length };
  });
  console.log('MIDI bytes:', JSON.stringify(midiBytes));

  console.log('LOGS', JSON.stringify(logs, null, 1));
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
