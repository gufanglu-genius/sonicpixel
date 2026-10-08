const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const FILE = '/Users/chenhuidediannao/Desktop/红头绳.wav';
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type()==='error') errs.push('C:'+m.text()); });

  const read = () => p.evaluate(() => ({
    bpm: document.querySelector('#mBpm')?.textContent.trim(),
    meter: document.querySelector('#mMeter')?.textContent.trim(),
    modeName: document.querySelector('#modeName')?.textContent.trim(),
    modeGlyph: document.querySelector('#modeGlyph')?.textContent.trim(),
    chips: [...document.querySelectorAll('#modeChips .chip')].map(c=>c.textContent.trim()),
    status: document.querySelector('#heroStatusText')?.textContent.trim() ||
            document.querySelector('#dropStatus')?.textContent.trim(),
    bpmOut: document.querySelector('#bpmOut')?.textContent.trim(),
    meterOut: document.querySelector('#meterOut')?.textContent.trim(),
  }));

  // ① 真歌示例
  await p.goto('http://127.0.0.1:8080/?fresh=1', { waitUntil: 'networkidle' });
  await p.click('#btnDemo');
  await p.waitForFunction(() => {
    const m = document.querySelector('#mBpm');
    return m && m.textContent.trim() !== '—';
  }, null, { timeout: 180000 });
  await p.waitForTimeout(1500);
  const demo = await read();
  console.log('① 真歌示例:', JSON.stringify(demo, null, 1));

  // ② 红头绳
  await p.goto('http://127.0.0.1:8080/?fresh=1', { waitUntil: 'networkidle' });
  await p.setInputFiles('#fileInput', FILE);
  await p.waitForFunction(() => {
    const m = document.querySelector('#mBpm');
    return m && m.textContent.trim() !== '—';
  }, null, { timeout: 180000 });
  await p.waitForTimeout(1500);
  const rh = await read();
  console.log('② 红头绳:', JSON.stringify(rh, null, 1));

  console.log('报错:', errs.length ? errs.join(' | ') : '无');
  await b.close();
  process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
