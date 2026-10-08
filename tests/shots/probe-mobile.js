const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:8080/?static=1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const info = await page.evaluate(() => {
    const rail = document.querySelector('.rail');
    const cs = getComputedStyle(rail);
    return {
      innerWidth: window.innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      railFlexDir: cs.flexDirection,
      railBottom: cs.bottom,
      railLeft: cs.left,
      railTop: cs.top,
      mq900: window.matchMedia('(max-width: 900px)').matches,
      mq1000: window.matchMedia('(min-width: 1000px)').matches,
      heroPadLeft: getComputedStyle(document.querySelector('.hero')).paddingLeft,
      widest: (() => {
        let w = 0, el = null;
        document.querySelectorAll('*').forEach((n) => {
          const r = n.getBoundingClientRect();
          if (r.width > w && r.width > 400) { w = r.width; el = n.className || n.tagName; }
        });
        return { w, el: String(el).slice(0, 80) };
      })(),
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();
