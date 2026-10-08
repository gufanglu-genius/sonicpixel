const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const U = 'http://127.0.0.1:8080/';
const S = '/tmp/sonic-shots/product';
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('P:', e.message));

  // 1) 首屏空态：新文案 + 两个示例按钮 + 无存盘行
  await p.goto(U + '?fresh=1&static=1', { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${S}/1-hero.png` });
  await p.locator('#sec-import').screenshot({ path: `${S}/2-import.png` });

  // 2) 真歌跑完 → 体检 + 存盘提示 + 清空按钮
  await p.click('#btnDemo');
  await p.waitForFunction(() => document.querySelector('#mBpm').textContent.trim() !== '—', { timeout: 180000 });
  await p.click('#btnProcess');
  await p.waitForFunction(() => !document.querySelector('#btnProcess').disabled, { timeout: 120000 });
  await p.click('#btnRender');
  await p.waitForFunction(() => document.querySelector('#btnRender').textContent === '重新渲染', { timeout: 120000 });
  await p.waitForFunction(() => /已自动存盘/.test(document.querySelector('#saveStatus').textContent), { timeout: 60000 });
  await p.waitForTimeout(600);
  await p.locator('#sec-import').screenshot({ path: `${S}/3-import-saved.png` });
  await p.locator('#sec-check').screenshot({ path: `${S}/4-check.png` });
  await p.locator('#sec-refine').screenshot({ path: `${S}/5-refine.png` });
  await p.locator('#sec-create').screenshot({ path: `${S}/6-create.png` });
  await p.locator('#sec-deliver').screenshot({ path: `${S}/7-deliver.png` });

  // 3) 恢复后
  await p.goto(U, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => /已恢复上次工作区/.test(document.querySelector('#dropStatus').textContent), { timeout: 180000 });
  await p.waitForTimeout(800);
  await p.locator('#sec-import').screenshot({ path: `${S}/8-restored.png` });

  // 4) 窄屏
  const p2 = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await p2.goto(U, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(600);
  await p2.locator('#sec-import').screenshot({ path: `${S}/9-mobile-import.png` });

  console.log('screenshots done');
  await b.close();
})();
