const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const OUT = '/tmp/sonic-shots';
const URL = 'http://127.0.0.1:8080/?static=1';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, '01-hero.png') });

  // 跑完整流水线
  await page.click('#btnDemo');
  await page.waitForFunction(() => !document.querySelector('#checkBody').hidden, { timeout: 30000 });
  await page.waitForTimeout(1200);

  for (const id of ['sec-import', 'sec-check', 'sec-refine', 'sec-create', 'sec-deliver']) {
    await page.evaluate((i) => {
      document.documentElement.style.scrollBehavior = 'auto';
      document.getElementById(i).scrollIntoView({ block: 'start' });
    }, id);
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(OUT, `sec-${id}.png`) });
  }

  // 精修
  await page.evaluate(() => document.getElementById('sec-refine').scrollIntoView({ block: 'start' }));
  await page.click('#btnProcess');
  await page.waitForFunction(() => document.querySelector('#btnProcess').textContent.includes('重新精修') || document.querySelector('#btnProcess').textContent.includes('失败'), { timeout: 30000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, '03-refined.png') });

  // 再生
  await page.evaluate(() => document.getElementById('sec-create').scrollIntoView({ block: 'start' }));
  await page.click('#btnRender');
  await page.waitForFunction(() => document.querySelector('#btnRender').textContent.includes('重新渲染') || document.querySelector('#btnRender').textContent.includes('失败'), { timeout: 30000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, '04-created.png') });

  // 回流
  await page.evaluate(() => document.getElementById('sec-deliver').scrollIntoView({ block: 'start' }));
  await page.click('#btnRecheck');
  await page.waitForTimeout(1100);
  await page.screenshot({ path: path.join(OUT, '05-deliver.png') });

  // 手机视口
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await m.goto(URL, { waitUntil: 'networkidle' });
  await m.waitForTimeout(700);
  await m.screenshot({ path: path.join(OUT, '06-m-hero.png') });
  await m.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto';
    document.getElementById('sec-check').scrollIntoView({ block: 'start' });
  });
  await m.waitForTimeout(400);
  await m.screenshot({ path: path.join(OUT, '07-m-check.png') });

  console.log('CONSOLE ERRORS:', errors.length ? errors.join('\n') : 'none');
  await browser.close();
  console.log('shots:', fs.readdirSync(OUT).filter(f => f.endsWith('.png')).sort().join(', '));
})();
