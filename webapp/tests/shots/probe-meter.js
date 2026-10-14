const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await b.newPage();
  p.on('pageerror', (e) => console.log('PAGE ERR:', e.message));
  await p.goto('http://127.0.0.1:8080/?static=1', { waitUntil: 'networkidle' });
  const out = await p.evaluate(async () => {
    const ctx = new AudioContext();
    const demo = await window.SonicEngine.synthesizeDemo();
    const r1 = await fetch('assets/_probe.wav');
    const real = await ctx.decodeAudioData(await r1.arrayBuffer());
    const g = (buf, label) => {
      const pr = window.SonicEngine.analyze(buf);
      return { label, meter: pr.identity.meter, conf: pr.identity.meterConfidence, scores: pr.raw.meterScores };
    };
    return [g(demo, 'demo'), g(real, 'real')];
  });
  console.log(JSON.stringify(out, null, 2));
  await b.close();
})();
