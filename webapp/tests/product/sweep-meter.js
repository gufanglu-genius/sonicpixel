/* 拍号指标在真歌上到底出不出数：批量体检，只读 L1 */
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const FILES = process.argv.slice(2);
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle' });
  const rows = [];
  for (const f of FILES) {
    const t = Date.now();
    await p.setInputFiles('#fileInput', f);
    const ok = await p.waitForFunction((prev) => {
      const m = document.querySelector('#mBpm');
      return m && m.textContent.trim() !== '—' && document.querySelector('#mMeter');
    }, null, { timeout: 120000 }).then(()=>true).catch(()=>false);
    await p.waitForTimeout(1500);
    const s = await p.evaluate(() => ({
      bpm: document.querySelector('#mBpm')?.textContent.trim(),
      meter: document.querySelector('#mMeter')?.textContent.trim(),
      dur: document.querySelector('#mDur')?.textContent.trim(),
      chips: [...document.querySelectorAll('#modeChips .chip')].map(c=>c.textContent.replace(/\s+/g,'')).join(' '),
    }));
    rows.push({ file: f.split('/').pop(), ms: Date.now()-t, ...s });
    console.log(`${rows.length}/${FILES.length}  ${rows[rows.length-1].file}  ${JSON.stringify(rows[rows.length-1])}`);
  }
  const withMeter = rows.filter(r => r.meter && r.meter !== '—');
  console.log(`\n拍号有输出: ${withMeter.length} / ${rows.length}`);
  withMeter.forEach(r => console.log(`   ${r.file}: ${r.meter}`));
  console.log('报错:', errs.length ? errs.join('|') : '无');
  await b.close();
})();
