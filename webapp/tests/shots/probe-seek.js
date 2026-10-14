/* 诊断：点波形为什么没跳转 */
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const CHROME = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', e => console.log('PAGEERR', e.message));
  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle' });
  await page.click('#btnDemo');
  await page.waitForFunction(() => {
    const b = document.querySelector('#checkBody');
    return b && !b.hidden && document.querySelector('#mBpm') && !document.querySelector('#mBpm').classList.contains('is-empty');
  }, { timeout: 90000 });
  console.log('导入完成');

  await page.evaluate(() => document.querySelector('#chartWave').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(800);

  const info = await page.evaluate(() => {
    const cv = document.querySelector('#chartWave');
    const r = cv.getBoundingClientRect();
    const cx = r.left + r.width * 0.72, cy = r.top + r.height / 2;
    const at = document.elementFromPoint(cx, cy);
    const hits = document.elementsFromPoint(cx, cy).map(e => e.tagName + (e.id ? '#'+e.id : '') + (e.className && typeof e.className === 'string' ? '.'+e.className.split(' ').join('.') : ''));
    // 画布自身的属性 vs CSS 尺寸
    const cs = getComputedStyle(cv);
    return {
      rect: { l: r.left, t: r.top, w: r.width, h: r.height },
      attrW: cv.width, attrH: cv.height,
      cssW: cs.width, cssH: cs.height, cssPos: cs.position, pointerEvents: cs.pointerEvents,
      at: at ? at.tagName + (at.id ? '#'+at.id : '') : null,
      stack: hits,
      // 检查 reveal 是否还在动画/遮挡
      revealAncestors: (() => {
        const out = [];
        let e = cv;
        while (e && e !== document.body) {
          const s = getComputedStyle(e);
          if (e.classList.contains('reveal') || s.opacity !== '1' || s.pointerEvents === 'none' || s.visibility !== 'visible') {
            out.push(e.tagName + (e.id ? '#'+e.id : '') + ' cls=' + (e.className||'') + ' op=' + s.opacity + ' pe=' + s.pointerEvents + ' vis=' + s.visibility + ' tf=' + s.transform);
          }
          e = e.parentElement;
        }
        return out;
      })(),
      // 父容器有没有 overflow 裁掉
      wrap: (() => {
        const w = cv.parentElement;
        const s = getComputedStyle(w);
        return { cls: w.className, overflow: s.overflow, w: w.getBoundingClientRect().width, h: w.getBoundingClientRect().height };
      })(),
    };
  });
  console.log(JSON.stringify(info, null, 2));

  // 直接派发 click 事件到 canvas，看处理器跑不跑
  const dispatched = await page.evaluate(() => {
    const cv = document.querySelector('#chartWave');
    const r = cv.getBoundingClientRect();
    const ev = new MouseEvent('click', { clientX: r.left + r.width * 0.72, clientY: r.top + r.height / 2, bubbles: true, cancelable: true });
    cv.dispatchEvent(ev);
    return {
      cur: document.querySelector('#wavePlayCur').textContent,
      fill: document.querySelector('#wavePlayFill').style.width,
      listen: document.querySelector('#btnListen').textContent,
    };
  });
  console.log('直接 dispatch 后:', JSON.stringify(dispatched));

  // 用 playwright 真点一次，对比
  const box = await page.locator('#chartWave').boundingBox();
  console.log('boundingBox:', JSON.stringify(box));
  await page.mouse.click(box.x + box.width * 0.72, box.y + box.height / 2);
  await page.waitForTimeout(400);
  const afterMouse = await page.evaluate(() => ({
    cur: document.querySelector('#wavePlayCur').textContent,
    fill: document.querySelector('#wavePlayFill').style.width,
    listen: document.querySelector('#btnListen').textContent,
    at: (() => {
      const cv = document.querySelector('#chartWave');
      const r = cv.getBoundingClientRect();
      const e = document.elementFromPoint(r.left + r.width * 0.72, r.top + r.height / 2);
      return e ? e.tagName + (e.id ? '#'+e.id : '') + '.' + (e.className||'') : null;
    })(),
  }));
  console.log('mouse.click 后:', JSON.stringify(afterMouse));

  await browser.close();
})().catch(e => { console.error(e); process.exit(2); });
