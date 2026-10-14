const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  // 平板
  const t = await browser.newPage({ viewport: { width: 820, height: 1100 } });
  await t.goto('http://127.0.0.1:8080/?static=1', { waitUntil: 'networkidle' });
  await t.waitForTimeout(600);
  await t.screenshot({ path: 't0-hero.png' });
  await t.click('#btnDemo');
  await t.waitForFunction(() => !document.querySelector('#checkBody').hidden, { timeout: 30000 });
  await t.waitForTimeout(700);
  await t.evaluate(() => { document.documentElement.style.scrollBehavior='auto'; document.getElementById('sec-check').scrollIntoView({block:'start'}); });
  await t.waitForTimeout(400);
  await t.screenshot({ path: 't1-check.png' });
  await t.evaluate(() => { const el=document.querySelector('.eq-layout'); if(el) el.scrollIntoView({block:'center'}); });
  await t.waitForTimeout(400);
  await t.screenshot({ path: 't2-eq.png' });

  // 非 static：检查 reveal 不会卡住
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  await p.screenshot({ path: 'u0-firstpaint.png' });
  await p.evaluate(() => { document.documentElement.style.scrollBehavior='auto'; document.getElementById('sec-import').scrollIntoView({block:'start'}); });
  await p.waitForTimeout(900);
  await p.screenshot({ path: 'u1-import.png' });
  const revealed = await p.evaluate(() => ({
    total: document.querySelectorAll('.reveal').length,
    isIn: document.querySelectorAll('.reveal.is-in').length,
  }));
  console.log('reveal', JSON.stringify(revealed));
  // hero 无 static 的英文断行
  const en = await p.evaluate(() => {
    const el = document.querySelector('.hero h1 .en');
    return el ? { text: el.innerText, html: el.innerHTML.slice(0, 120) } : null;
  });
  console.log('en', JSON.stringify(en));
  await browser.close();
})();
