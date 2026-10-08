const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const FILE = '/Users/chenhuidediannao/Downloads/3922d0a4-e33e-4b55-9ccd-4bf681e9f175.wav';
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', e => console.log('P:', e.message));
  await p.goto('http://127.0.0.1:8080/?fresh=1', { waitUntil: 'networkidle' });
  await p.setInputFiles('#fileInput', FILE);
  await p.waitForFunction(() => document.querySelector('#mBpm').textContent.trim() !== '—', { timeout: 180000 });
  const r = await p.evaluate(() => {
    const t = (s) => (document.querySelector(s)?.textContent || '').trim();
    return {
      drop: t('#dropStatus'), bpm: t('#mBpm'), meter: t('#mMeter'), dur: t('#mDur'),
      sr: t('#mSr'), thd: t('#mThd'), lra: t('#mLra'), cent: t('#mCent'),
      crest: t('#mCrest'), mud: t('#mMud'), mudSub: t('#mMudSub'),
      mode: t('#modeName'), keyChips: [...document.querySelectorAll('#modeChips .chip')].map(e=>e.textContent.trim()),
      prescription: [...document.querySelectorAll('#prescription .prescription-item')].map(e=>e.textContent.trim().replace(/\s+/g,' ')),
      strength: document.querySelector('#strength').value,
      eq: [...document.querySelectorAll('.eq-band input')].map(i=>i.value).join(','),
      eqTag: t('#eqTag'),
      structure: [...document.querySelectorAll('#structureLegend .legend-item')].map(e=>e.textContent.trim()),
      style: [...document.querySelectorAll('#styleModeChips .chip')].map(e=>e.textContent.trim()),
    };
  });
  console.log(JSON.stringify(r, null, 2));
  await p.screenshot({ path: '/tmp/sonic-shots/product/song-check.png', fullPage: false });
  await b.close();
})();
