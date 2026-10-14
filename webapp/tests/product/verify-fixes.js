const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const FILE = '/Users/chenhuidediannao/Desktop/红头绳.wav';
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type()==='error') errs.push('C:'+m.text()); });

  await p.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle' });
  const read = () => p.evaluate(() => ({
    mBpm: document.querySelector('#mBpm')?.textContent.trim(),
    mMeter: document.querySelector('#mMeter')?.textContent.trim(),
    badge: document.querySelector('#meterOut')?.textContent.trim(),
    badgeTitle: document.querySelector('#meterOut')?.title,
    hint: document.querySelector('#meterHint')?.textContent.trim(),
    bpmRange: document.querySelector('#bpmRange')?.value,
    bpmOut: document.querySelector('#bpmOut')?.textContent.trim(),
    bpmMax: document.querySelector('#bpmRange')?.max,
  }));

  const idle = await read();
  console.log('① 体检前(静止)     ', JSON.stringify(idle));

  await p.setInputFiles('#fileInput', FILE);
  await p.waitForFunction(() => {
    const m = document.querySelector('#mBpm');
    return m && m.textContent.trim() !== '—' && m.textContent.trim() !== '';
  }, { timeout: 120000 });
  await p.waitForTimeout(2000);
  const l1 = await read();
  console.log('② 体检后·渲染前    ', JSON.stringify(l1));

  await p.click('#btnRender');
  await p.waitForFunction(() => {
    const b = document.querySelector('#btnRender');
    return b && (b.textContent.includes('重新渲染') || b.textContent.includes('失败'));
  }, { timeout: 120000 });
  await p.waitForTimeout(1000);
  const l3 = await read();
  console.log('③ 渲染后           ', JSON.stringify(l3));

  // 回流文案里的速度
  await p.click('#btnRecheck');
  await p.waitForFunction(() => {
    const vs = [...document.querySelectorAll('#checks .check-value')];
    return vs.length && vs.every(v => v.textContent.trim() !== '待执行');
  }, { timeout: 120000 }).catch(()=>{});
  await p.waitForTimeout(600);
  const checks = await p.evaluate(() => [...document.querySelectorAll('#checks .check')].map(c => ({
    n: c.querySelector('.check-name')?.textContent.trim(),
    v: c.querySelector('.check-value')?.textContent.trim(),
    note: c.querySelector('p:last-of-type')?.textContent.trim(),
    cls: c.className,
  })));
  console.log('④ 回流             ', JSON.stringify(checks, null, 1));

  console.log('\n判据:');
  // #bpmOut 的文案是「139.9 BPM」，拿它和裸数字做 === 永远为假；
  // 真正要问的是：体检值有没有接到滑块和标签上，所以三处都取数值比。
  const n = (x) => parseFloat(x);
  const A = n(l1.mBpm) === n(l1.bpmOut) && n(l1.bpmRange) === n(l1.mBpm) && isFinite(n(l1.mBpm));
  console.log(`  A 速度接上体检 : ${A ? '✓' : '✗'}  L1=${l1.mBpm} 滑块=${l1.bpmRange} 标签=${l1.bpmOut}`);
  const B1 = l1.hint.includes('原曲未定');
  console.log(`  B1 未测出时不撒谎: ${B1 ? '✓' : '✗'}  提示「${l1.hint}」`);
  const B2 = /未测出|体检/.test(l3.badgeTitle || '');
  console.log(`  B2 渲染后出处诚实: ${B2 ? '✓' : '✗'}  徽章「${l3.badge}」标题「${l3.badgeTitle}」`);
  console.log('  报错:', errs.length ? errs.join(' | ') : '无');
  await b.close();
  process.exit((A && B1 && B2 && !errs.length) ? 0 : 1);
})();
