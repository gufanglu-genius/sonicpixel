const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const FILE = '/Users/chenhuidediannao/Desktop/红头绳.wav';
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle' });
  await p.setInputFiles('#fileInput', FILE);
  await p.waitForFunction(() => window.__state && window.__state.profile, { timeout: 120000 });
  await p.waitForTimeout(1500);

  const origin = await p.evaluate(() => {
    const q = __state.profile.quality;
    return { resid: q.nonharmonicRatio ?? q.thd, lra: q.lra, crest: q.crest, peak: q.peak };
  });
  console.log('原曲 音质:', JSON.stringify(origin));

  const render = async ({ bars, bpm, mode, mute }) => {
    await p.evaluate(({ bars, bpm, mode, mute }) => {
      if (bars != null) { document.querySelector('#barsRange').value = bars;
        document.querySelector('#barsOut').textContent = bars + ' 小节'; }
      if (bpm != null) { document.querySelector('#bpmRange').value = bpm;
        document.querySelector('#bpmOut').textContent = bpm + ' BPM'; }
      if (mode != null) {
        const chips = [...document.querySelectorAll('#modeSelect .chip')];
        if (chips[mode]) chips[mode].click();
      }
      __state.muted = mute || {};
    }, { bars, bpm, mode, mute });
    await p.click('#btnRender');
    await p.waitForFunction(() => {
      const b = document.querySelector('#btnRender');
      return b && (b.textContent.includes('重新渲染') || b.textContent.includes('失败'));
    }, { timeout: 120000 });
    await p.waitForTimeout(400);
    return p.evaluate(() => {
      const q = __state.profileArrangement?.quality;
      return q ? { resid: +(q.nonharmonicRatio ?? q.thd), lra: q.lra, crest: q.crest, peak: q.peak,
                   dur: __state.arrangement?.duration } : null;
    });
  };

  const rows = [];
  for (const cfg of [
    { bars: 2,  bpm: 40 },
    { bars: 8,  bpm: 92 },
    { bars: 8,  bpm: 139.9 },
    { bars: 12, bpm: 200 },
    { bars: 8,  bpm: 92, mode: 4 },        // 羽调
    { bars: 8,  bpm: 92, mute: {1:1,3:1} },// 静音两轨
  ]) {
    const q = await render(cfg);
    rows.push({ cfg, q });
    console.log(`${JSON.stringify(cfg).padEnd(46)} → ${JSON.stringify(q)}`);
  }
  const lras = rows.filter(r=>r.q).map(r=>r.q.lra);
  const resids = rows.filter(r=>r.q).map(r=>r.q.resid);
  console.log(`\nLRA   min=${Math.min(...lras)} max=${Math.max(...lras)}`);
  console.log(`残余  min=${Math.min(...resids)} max=${Math.max(...resids)}`);
  console.log(`原曲LRA=${origin.lra} ×0.45=${(origin.lra*0.45).toFixed(2)}  →  乐段全部低于该线: ${lras.every(l=>l<origin.lra*0.45)}`);
  console.log('报错:', errs.length ? errs.join('|') : '无');
  await b.close();
})();
