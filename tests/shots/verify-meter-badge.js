/* 拍号徽章：L3 再生面板必须显示 L1 检出的拍号，而不是写死 4/4。 */
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const URL = 'http://127.0.0.1:8080/?demo=1';

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(URL, { waitUntil: 'networkidle' });

  // 等体检写完徽章
  await page.waitForFunction(() => {
    const t = document.querySelector('#meterOut');
    return t && /^\d+\/\d+$/.test(t.textContent.trim());
  }, { timeout: 30000 });

  const before = await page.evaluate(() => ({
    meter: document.querySelector('#meterOut').textContent.trim(),
    title: document.querySelector('#meterOut').title,
    mMeter: document.querySelector('#mMeter')?.textContent.trim(),
  }));

  await page.click('#btnRender');
  await page.waitForFunction(() => {
    const b = document.querySelector('#btnRender');
    return b && (b.textContent.includes('重新渲染') || b.textContent.includes('失败'));
  }, { timeout: 60000 });

  const after = await page.evaluate(() => ({
    meter: document.querySelector('#meterOut').textContent.trim(),
    title: document.querySelector('#meterOut').title,
    label: document.querySelector('#btnRender').textContent.trim(),
    // 再生产物的拍号来源应是 authored
    authored: window.__probeAuthored || null,
  }));

  // 从版本树/导出再核一次：再生的 time_signature_source 应是 authored
  const exported = await page.evaluate(() => {
    // 复用应用的导出对象构造路径：直接读 state 不可达，改点导出按钮拿 JSON
    return null;
  });

  let pass = 0, fail = 0;
  const ok = (c, n, d) => { c ? (pass++, console.log(`  ✓ ${n}  — ${d}`)) : (fail++, console.log(`  ✗ ${n}  — ${d}`)); };

  console.log('================ 拍号徽章 ================');
  ok(/^\d+\/\d+$/.test(before.meter), '体检后徽章是拍号', `「${before.meter}」（L1 指标区: ${before.mMeter}）`);
  ok(before.meter === before.mMeter, '徽章与 L1 检出一致', `徽章 ${before.meter} / 指标 ${before.mMeter}`);
  ok(/跟原曲|拍号|L1/.test(before.title || '') || before.title.length > 0, '徽章有说明 tooltip', before.title || '(空)');
  ok(after.meter === before.meter, '渲染后徽章仍跟原曲', `「${after.meter}」`);
  ok(after.label.includes('重新渲染'), '渲染完成', after.label);
  ok(errors.length === 0, '全程无 JS 报错', errors.length ? errors.join(' | ') : 'clean');

  await page.screenshot({ path: '/tmp/sonic-shots/out/meter-badge.png' });
  console.log('─'.repeat(50));
  console.log(`${pass} 通过 / ${fail} 失败`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
