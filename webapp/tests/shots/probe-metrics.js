const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERR:', m.text()); });
  page.on('pageerror', (e) => console.log('PAGE ERR:', e.message));
  await page.goto('http://127.0.0.1:8080/?static=1', { waitUntil: 'networkidle' });

  const out = await page.evaluate(async () => {
    const buf = await window.SonicEngine.synthesizeDemo();
    const p = window.SonicEngine.analyze(buf);
    const processed = await window.SonicEngine.process(buf, {
      highpass: 30,
      eq: new Array(10).fill(0),
      exciter: 0.3, denoise: 0.25,
      threshold: 0.35, ratio: 0.32, intensity: 0.55,
    });
    const p2 = window.SonicEngine.analyze(processed);
    return {
      orig: {
        bpm: p.identity.bpm, bpmConf: p.identity.bpmConfidence,
        key: p.identity.key, mode: p.identity.mode, modeName: p.identity.modeName,
        modeConf: p.identity.modeConfidence, pentaFit: p.identity.pentaFit,
        meter: p.identity.meter,
        thd: p.quality.thd, thdCov: p.quality.thdCoverage,
        lra: p.quality.lra, crest: p.quality.crest, mud: p.quality.mudScore,
        flatness: p.timbre.flatness,
        struct: p.structure.map((s) => `${s.section}(${s.start}-${s.end},e=${s.energy})`).join(' '),
        nSegs: p.structure.length,
        melody: { notes: p.melody.noteCount, range: p.melody.rangeSemitones, contourLen: p.melody.contour.length, rhythmLen: p.melody.rhythmNgram.length },
      },
      after: {
        thd: p2.quality.thd, thdCov: p2.quality.thdCoverage,
        lra: p2.quality.lra, crest: p2.quality.crest,
        peak: p2.quality.peak, rms: p2.quality.rms,
        meter: p2.identity.meter,
      },
    };
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})();
