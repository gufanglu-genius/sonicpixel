const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
(async () => {
  const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const errs = [];
  page.on('pageerror', e => errs.push('PE: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CE: ' + m.text()); });
  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle' });
  await page.click('#btnDemo');
  // waitForFunction 第二参是透传给页面函数的 arg，options 必须放第三参（老写法 timeout 被当 arg 吞掉）
  await page.waitForFunction(() => !document.querySelector('#checkBody').hidden, null, { timeout: 30000 });
  await page.click('#btnRender');
  await page.waitForFunction(() => document.querySelector('#btnRender').textContent.includes('重新渲染') || document.querySelector('#btnRender').textContent.includes('失败'), null, { timeout: 30000 });
  // 导出 MIDI
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#btnExportMidi'),
  ]);
  const midiPath = '/tmp/sonic-shots/out.mid';
  await dl.saveAs(midiPath);
  console.log('midi download:', dl.suggestedFilename());
  // 导出档案
  const [dl2] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#btnExportProfile'),
  ]);
  console.log('profile download:', dl2.suggestedFilename());
  const profPath = '/tmp/sonic-shots/out.json';
  await dl2.saveAs(profPath);
  console.log('errors:', errs.length ? errs.join(' | ') : 'none');
  await browser.close();
})();
