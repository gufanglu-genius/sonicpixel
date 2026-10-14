const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const CHROME = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
(async () => {
  const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox','--autoplay-policy=no-user-gesture-required'] });
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.addInitScript(() => {
    window.__A = { made: [], srcCtx: null, starts: [] };
    const O = window.AudioContext || window.webkitAudioContext;
    window.AudioContext = function (...a) {
      const c = new O(...a);
      window.__A.made.push(c);
      return c;
    };
    window.webkitAudioContext = window.AudioContext;
    const P = window.AudioBufferSourceNode.prototype;
    const os = P.start;
    P.start = function (...a) {
      try {
        window.__A.srcCtx = this.context;
        window.__A.starts.push({ ctxIsMade: window.__A.made.includes(this.context), offset: a[1]||0, t: this.context.currentTime, state: this.context.state });
      } catch (e) {}
      return os.apply(this, a);
    };
  });
  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle' });
  await page.click('#btnDemo');
  await page.waitForFunction(() => {
    const el = document.querySelector('#checkBody');
    return el && !el.hidden && document.querySelector('#mBpm') && !document.querySelector('#mBpm').classList.contains('is-empty');
  }, { timeout: 90000 });
  console.log('导入后 made =', await page.evaluate(() => window.__A.made.length));

  await page.click('#btnListen');
  const snap = (label) => page.evaluate((label) => {
    const A = window.__A, c = A.srcCtx;
    return {
      label,
      made: A.made.length,
      srcCtxState: c && c.state,
      srcCtxTime: c && c.currentTime,
      madeTimes: A.made.map(x => ({ t: x.currentTime, s: x.state })),
      starts: A.starts.length,
      lastStart: A.starts.slice(-1)[0],
      fill: document.querySelector('#wavePlayFill').style.width,
      cur: document.querySelector('#wavePlayCur').textContent,
      listen: document.querySelector('#btnListen').textContent,
    };
  }, label);

  for (const ms of [200, 800, 1500, 2500]) {
    await page.waitForTimeout(ms === 200 ? 200 : ms - 0);
    // 只是顺序等待，打印一次
  }
  // 分别取样
  await page.waitForTimeout(300); console.log(JSON.stringify(await snap('t+0.3s')));
  await page.waitForTimeout(900); console.log(JSON.stringify(await snap('t+1.2s')));
  await page.waitForTimeout(1500); console.log(JSON.stringify(await snap('t+2.7s')));
  await b.close();
})().catch(e => { console.error(e); process.exit(2); });
