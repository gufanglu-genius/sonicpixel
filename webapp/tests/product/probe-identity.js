const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const FILE = '/Users/chenhuidediannao/Desktop/红头绳.wav';
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle' });
  await p.setInputFiles('#fileInput', FILE);

  // 每 800ms 采一次，看 identity 各字段什么时候落定
  const seen = [];
  for (let i = 0; i < 25; i++) {
    await p.waitForTimeout(800);
    const s = await p.evaluate(() => ({
      mBpm: document.querySelector('#mBpm')?.textContent.trim(),
      mMeter: document.querySelector('#mMeter')?.textContent.trim(),
      badge: document.querySelector('#meterOut')?.textContent.trim(),
      bpmRange: document.querySelector('#bpmRange')?.value,
      bpmOut: document.querySelector('#bpmOut')?.textContent.trim(),
      chipMeter: [...document.querySelectorAll('#modeChips .chip')].map(c=>c.textContent.trim()).find(t=>t.includes('拍号')),
      stateMeter: (window.state && state.profile && state.profile.identity) ? state.profile.identity.meter : 'no-state',
      stateBpm: (window.state && state.profile && state.profile.identity) ? state.profile.identity.bpm : 'no-state',
      stateMode: (window.state && state.profile && state.profile.identity) ? state.profile.identity.mode : 'no-state',
    }));
    const key = JSON.stringify(s);
    if (!seen.length || seen[seen.length-1].k !== key) seen.push({ t: (i+1)*0.8, k: key, s });
    if (s.mMeter !== '—' && s.mMeter !== undefined && s.mMeter !== '' && i > 6) break;
  }
  console.log('=== identity 轨迹（只列变化）===');
  seen.forEach(x => console.log(`t=${x.t}s  ${x.k}`));
  console.log('最终:', JSON.stringify(seen[seen.length-1]?.s, null, 1));
  if (errs.length) console.log('ERR:', errs.join('|'));
  await b.close();
})();
