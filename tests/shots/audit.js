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
  await page.waitForTimeout(600);

  // 全链路
  await page.click('#btnDemo');
  await page.waitForFunction(() => !document.querySelector('#checkBody').hidden, { timeout: 30000 });
  await page.waitForTimeout(900);

  const grab = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? el.innerText.replace(/\n+/g, ' | ').slice(0, 400) : '(missing)';
  }, sel);

  console.log('--- 指标 ---');
  console.log('chips:', await grab('#checkBody .chips'));
  console.log('metrics:', await grab('.metric-grid'));
  console.log('rail active:', await page.evaluate(() => {
    const a = document.querySelector('.rail-item.is-active');
    return a ? a.innerText.replace(/\n/g, ' ') : 'none';
  }));

  // 体检区
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; document.getElementById('sec-check').scrollIntoView({ block: 'start' }); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'a-check.png') });

  // 精修
  await page.click('#btnProcess');
  await page.waitForFunction(() => document.querySelector('#btnProcess').textContent.includes('重新精修') || document.querySelector('#btnProcess').textContent.includes('失败'), { timeout: 30000 });
  await page.waitForTimeout(600);
  console.log('--- 精修 ---');
  console.log('prescription:', await grab('#prescription'));
  console.log('refine meta:', await grab('#refineMeta, .eq-layout, #refineBody .row'));

  // EQ 区（滚动到动态均衡）
  await page.evaluate(() => {
    const el = document.querySelector('.eq-layout') || document.querySelector('#chartEq');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(OUT, 'b-eq.png') });

  // 波形
  await page.evaluate(() => {
    const el = document.querySelector('#chartWave') || document.querySelector('#waveWrap');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'c-wave.png') });

  // 再生
  await page.click('#btnRender');
  await page.waitForFunction(() => document.querySelector('#btnRender').textContent.includes('重新渲染') || document.querySelector('#btnRender').textContent.includes('失败'), { timeout: 30000 });
  await page.waitForTimeout(700);
  console.log('--- 再生 ---');
  console.log('tracks:', await grab('#tracks'));
  await page.evaluate(() => document.getElementById('sec-create').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'd-create.png') });

  // 钢琴卷帘
  await page.evaluate(() => {
    const el = document.querySelector('#chartPiano');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'e-piano.png') });

  // 回流
  await page.click('#btnRecheck');
  await page.waitForTimeout(1200);
  console.log('--- 交付 ---');
  console.log('checks:', await grab('#checks, .checks'));
  console.log('tree:', await grab('.tree'));
  await page.evaluate(() => document.getElementById('sec-deliver').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'f-deliver.png') });
  await page.evaluate(() => {
    const el = document.querySelector('.tree');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, 'g-tree.png') });

  // 手机
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await m.goto(URL, { waitUntil: 'networkidle' });
  await m.waitForTimeout(500);
  await m.click('#btnDemo');
  await m.waitForFunction(() => !document.querySelector('#checkBody').hidden, { timeout: 30000 });
  await m.waitForTimeout(800);
  for (const [id, name] of [['sec-check', 'h-m-check'], ['sec-refine', 'i-m-refine'], ['sec-create', 'j-m-create'], ['sec-deliver', 'k-m-deliver']]) {
    await m.evaluate((i) => { document.documentElement.style.scrollBehavior = 'auto'; document.getElementById(i).scrollIntoView({ block: 'start' }); }, id);
    await m.waitForTimeout(400);
    await m.screenshot({ path: path.join(OUT, `${name}.png`) });
  }
  // 手机 EQ / 编配
  await m.evaluate(() => { const el = document.querySelector('.eq-layout'); if (el) el.scrollIntoView({ block: 'center' }); });
  await m.waitForTimeout(350);
  await m.screenshot({ path: path.join(OUT, 'l-m-eq.png') });

  console.log('CONSOLE ERRORS:', errors.length ? errors.join('\n') : 'none');
  await browser.close();
})();
