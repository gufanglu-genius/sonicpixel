/* 产品验收：真文件走完五站，逐步截图 + 抓报错 */
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const URL = 'http://127.0.0.1:8080/';
const FILE = process.argv[2] || '/Users/chenhuidediannao/Desktop/红头绳.wav';
const TAG = (process.argv[3] || 'demo').replace(/[^\w.-]/g, '_');
const OUT = '/tmp/sonic-shots/product';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  const shot = async (name) => { await page.screenshot({ path: `${OUT}/${TAG}-${name}.png`, fullPage: false }); };

  await page.goto(URL, { waitUntil: 'networkidle' });
  await sleep(600);
  await shot('01-hero');

  // 上传真文件
  await page.setInputFiles('#fileInput', FILE);
  // 等体检出结果
  const analyzed = await page.waitForFunction(() => {
    const b = document.querySelector('#checkBody');
    const m = document.querySelector('#mBpm');
    return b && !b.hidden && m && m.textContent.trim() && m.textContent.trim() !== '—';
  }, { timeout: 120000 }).then(() => true).catch(() => false);

  await sleep(1200);
  const l1 = await page.evaluate(() => ({
    bpm: document.querySelector('#mBpm')?.textContent.trim(),
    meter: document.querySelector('#mMeter')?.textContent.trim(),
    dur: document.querySelector('#mDur')?.textContent.trim(),
    sr: document.querySelector('#mSr')?.textContent.trim(),
    thd: document.querySelector('#mThd')?.textContent.trim(),
    lra: document.querySelector('#mLra')?.textContent.trim(),
    cent: document.querySelector('#mCent')?.textContent.trim(),
    crest: document.querySelector('#mCrest')?.textContent.trim(),
    mud: document.querySelector('#mMud')?.textContent.trim(),
    modeGlyph: document.querySelector('#modeGlyph')?.textContent.trim(),
    modeName: document.querySelector('#modeName')?.textContent.trim(),
    chips: [...document.querySelectorAll('#modeChips .chip')].map(c => c.textContent.trim()),
    status: document.querySelector('#heroStatusText')?.textContent.trim(),
  }));
  console.log('L1 体检:', JSON.stringify(l1));
  await page.evaluate(() => document.querySelector('#sec-check').scrollIntoView({ block: 'start' }));
  await sleep(500);
  await shot('02-check');

  // L2 精修
  const hasRefine = await page.waitForFunction(() => {
    const b = document.querySelector('#refineBody');
    return b && !b.hidden;
  }, { timeout: 60000 }).then(() => true).catch(() => false);
  await page.evaluate(() => document.querySelector('#sec-refine').scrollIntoView({ block: 'start' }));
  await sleep(400);
  await shot('03-refine-before');
  if (hasRefine) {
    await page.click('#btnProcess');
    await page.waitForFunction(() => {
      const b = document.querySelector('#btnProcess');
      return b && !b.disabled && /完成|重新|执行/.test(b.textContent);
    }, { timeout: 120000 }).catch(() => {});
    await sleep(800);
    await shot('04-refine-after');
  }

  // L3 再生
  await page.evaluate(() => document.querySelector('#sec-create').scrollIntoView({ block: 'start' }));
  await sleep(400);
  await page.click('#btnRender');
  const rendered = await page.waitForFunction(() => {
    const b = document.querySelector('#btnRender');
    return b && (b.textContent.includes('重新渲染') || b.textContent.includes('失败'));
  }, { timeout: 120000 }).then(() => true).catch(() => false);
  await sleep(800);
  const meter = await page.evaluate(() => document.querySelector('#meterOut')?.textContent.trim());
  console.log('L3 拍号徽章:', meter, '渲染成功:', rendered);
  await shot('05-create');

  // L4 交付
  await page.evaluate(() => document.querySelector('#sec-deliver').scrollIntoView({ block: 'start' }));
  await sleep(400);
  await shot('06-deliver-before');
  await page.click('#btnRecheck');
  const rechecked = await page.waitForFunction(() => {
    const vs = [...document.querySelectorAll('#checks .check-value')];
    return vs.length && vs.every(v => v.textContent.trim() !== '待执行');
  }, { timeout: 120000 }).then(() => true).catch(() => false);
  await sleep(800);
  const checks = await page.evaluate(() => [...document.querySelectorAll('#checks .check')].map(c => ({
    name: c.querySelector('.check-name')?.textContent.trim(),
    value: c.querySelector('.check-value')?.textContent.trim(),
    cls: c.className,
  })));
  console.log('L4 回流:', JSON.stringify(checks));
  await shot('07-deliver-after');

  console.log('报错数:', errs.length);
  errs.slice(0, 20).forEach(e => console.log('  !', e));
  await browser.close();
  process.exit(errs.length ? 1 : 0);
})();
