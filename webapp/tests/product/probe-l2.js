/* 只做「体检→精修→回流」，绝不渲染：看 L2 对音质的真实影响 */
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const FILE = process.argv[2] || '/Users/chenhuidediannao/Desktop/红头绳.wav';
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle' });
  await p.setInputFiles('#fileInput', FILE);
  await p.waitForFunction(() => window.__state && window.__state.profile, { timeout: 120000 });
  await p.waitForTimeout(1200);

  const snap = () => p.evaluate(() => {
    const g = (pr) => pr ? { resid: +( (pr.quality.nonharmonicRatio ?? pr.quality.thd) ?? -1).toFixed(4),
                             lra: pr.quality.lra, crest: pr.quality.crest, peak: +(pr.quality.peak ?? -1).toFixed(3) } : null;
    return { origin: g(__state.profile), processed: g(__state.profileProcessed) };
  });
  console.log('体检后:', JSON.stringify(await snap()));

  await p.click('#btnProcess');
  await p.waitForFunction(() => {
    const b = document.querySelector('#btnProcess');
    return b && !b.disabled && /完成|重新|执行/.test(b.textContent);
  }, { timeout: 180000 }).catch(()=>{});
  await p.waitForTimeout(1500);
  const after = await snap();
  console.log('精修后:', JSON.stringify(after));

  // 只回流，不渲染 → derived 应是 profileProcessed
  await p.click('#btnRecheck');
  await p.waitForFunction(() => {
    const vs = [...document.querySelectorAll('#checks .check-value')];
    return vs.length && vs.every(v => v.textContent.trim() !== '待执行');
  }, { timeout: 120000 }).catch(()=>{});
  await p.waitForTimeout(800);
  const checks = await p.evaluate(() => [...document.querySelectorAll('#checks .check')].map(c => ({
    n: c.querySelector('.check-name')?.textContent.trim(),
    v: c.querySelector('.check-value')?.textContent.trim(),
    note: c.querySelector('p:last-of-type')?.textContent.trim(),
    cls: c.className.replace('check ',''),
  })));
  console.log('回流(仅精修):', JSON.stringify(checks, null, 1));

  const o = after.origin, pr = after.processed;
  if (o && pr) {
    console.log(`\nL2 实测: LRA ${o.lra} → ${pr.lra} dB (×${(pr.lra/o.lra).toFixed(2)}), 残余 ${(o.resid*100).toFixed(1)}% → ${(pr.resid*100).toFixed(1)}%, peak ${o.peak} → ${pr.peak}`);
    console.log(`45% 线 = ${(o.lra*0.45).toFixed(2)} dB → ${pr.lra >= o.lra*0.45 ? 'PASS' : 'FAIL'}`);
  }
  console.log('报错:', errs.length ? errs.join('|') : '无');
  await b.close();
})();
