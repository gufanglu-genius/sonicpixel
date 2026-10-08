const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGE ERR:', e.message));
  await page.goto('http://127.0.0.1:8080/?static=1', { waitUntil: 'networkidle' });

  const out = await page.evaluate(async () => {
    const res = await fetch('assets/_probe.wav');
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    const p = window.SonicEngine.analyze(buf);
    return {
      bpm: p.identity.bpm, bpmConf: p.identity.bpmConfidence,
      key: p.identity.key, mode: p.identity.mode, modeName: p.identity.modeName,
      modeConf: p.identity.modeConfidence, pentaFit: p.identity.pentaFit,
      meter: p.identity.meter,
      thd: p.quality.thd, thdCov: p.quality.thdCoverage,
      lra: p.quality.lra, crest: p.quality.crest, mud: p.quality.mudScore,
      lowRatio: p.quality.lowRatio, subRatio: p.quality.subRatio,
      flatness: p.timbre.flatness, centroid: p.timbre.centroid,
      nSegs: p.structure.length,
      struct: p.structure.map((s) => `${s.section}(${s.start}-${s.end},e=${s.energy})`).join(' | '),
      melody: { notes: p.melody.noteCount, range: p.melody.rangeSemitones, cLen: p.melody.contour.length, rLen: p.melody.rhythmNgram.length },
    };
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})();
