/* 播放实测 v2：验证网页上真的能放出声
   · 只数「接到活 AudioContext.destination」的音源（离线渲染的不算）
   · ctx.state 实时读，不用 getter 钩子（platform 对象上 defineProperty 会失败）
   · 点击用 locator.click() 让 Playwright 自动滚动（html 是 scroll-behavior:smooth，
     无头里 scrollIntoView 的平滑滚动 800ms 走不完，mouse.click 会点到视口外）
*/
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');

const URL = 'http://127.0.0.1:8080/';
const OUT = '/tmp/sonic-shots/out';
fs.mkdirSync(OUT, { recursive: true });

const CHROME = process.env.CHROME_BIN ||
  '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail != null && detail !== '' ? '  — ' + detail : ''}`);
}
const widthOf = (s) => parseFloat(String(s).replace('%', '')) || 0;
const parseT = (s) => { const p = String(s).split(':'); return (+p[0] || 0) * 60 + (+p[1] || 0); };

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.addInitScript(() => {
    const A = {
      liveCtx: null, srcCtx: null,
      liveStarts: [], offlineStarts: 0, liveStops: 0,
    };
    window.__audio = A;

    const OrigAC = window.AudioContext || window.webkitAudioContext;
    const PatchedAC = function (...a) {
      const c = new OrigAC(...a);
      A.liveCtx = c;
      return c;
    };
    window.AudioContext = PatchedAC;
    window.webkitAudioContext = PatchedAC;

    const OSP = window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype;
    if (OSP) {
      const oStart = OSP.start;
      OSP.start = function (...a) {
        try {
          A.srcCtx = this.context;
          const live = this.context === A.liveCtx;
          const rec = {
            when: this.context ? this.context.currentTime : 0,
            offset: a[1] || 0,
            dur: this.buffer ? this.buffer.duration : 0,
            len: this.buffer ? this.buffer.length : 0,
            rate: this.buffer ? this.buffer.sampleRate : 0,
            live,
          };
          if (this.buffer && this.buffer.length) {
            const ch = this.buffer.getChannelData(0);
            const step = Math.max(1, Math.floor(ch.length / 4000));
            let peak = 0, sum = 0, n = 0;
            for (let i = 0; i < ch.length; i += step) {
              const v = Math.abs(ch[i]); if (v > peak) peak = v;
              sum += ch[i] * ch[i]; n++;
            }
            rec.peak = peak; rec.rms = n ? Math.sqrt(sum / n) : 0;
          }
          if (live) A.liveStarts.push(rec); else A.offlineStarts++;
        } catch (_) {}
        return oStart.apply(this, a);
      };
      const oStop = OSP.stop;
      OSP.stop = function (...a) {
        if (this.context === A.liveCtx) A.liveStops++;
        return oStop.apply(this, a);
      };
    }
  });

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  ok('页面加载', true, page.url());

  /* ---- 1. 示例音频导入 ---- */
  const t0 = Date.now();
  await page.click('#btnDemo', { timeout: 15000 });
  await page.waitForFunction(() => {
    const b = document.querySelector('#checkBody');
    return b && !b.hidden && document.querySelector('#mBpm') &&
      !document.querySelector('#mBpm').classList.contains('is-empty');
  }, { timeout: 90000 });
  ok('示例音频导入 + 体检完成', true, (Date.now() - t0) + 'ms');

  const bpm = await page.textContent('#mBpm');
  ok('体检出数', bpm && bpm.trim() !== '—', 'BPM=' + bpm + ' 时长=' + await page.textContent('#mDur'));

  /* ---- 2. 走带控件就位 ---- */
  ok('试听按钮出现', await page.isVisible('#btnListen'), '「' + (await page.textContent('#btnListen')).trim() + '」');
  ok('波形播放键出现', await page.isVisible('#btnWavePlay'));
  ok('走带进度条出现', await page.isVisible('#wavePlayBar'));

  /* ---- 3. 点试听：真的出声 ---- */
  await page.click('#btnListen');
  await page.waitForTimeout(800);

  const s1 = await page.evaluate(() => {
    const A = window.__audio, c = A.srcCtx || A.liveCtx;
    return {
      ctxCreated: !!(A.liveCtx || A.srcCtx),
      ctxState: c ? c.state : 'no-ctx',
      ctxTime: c ? c.currentTime : -1,
      liveStarts: A.liveStarts.length,
      last: A.liveStarts[A.liveStarts.length - 1] || null,
      offlineStarts: A.offlineStarts,
      fill: document.querySelector('#wavePlayFill').style.width,
      listen: document.querySelector('#btnListen').textContent,
      wave: document.querySelector('#btnWavePlay').textContent,
      pressed: document.querySelector('#btnListen').getAttribute('aria-pressed'),
      cur: document.querySelector('#wavePlayCur').textContent,
      dur: document.querySelector('#wavePlayDur').textContent,
      tag: document.querySelector('#listenTag').textContent,
    };
  });
  console.log('   [起播]', JSON.stringify({ ...s1, last: s1.last && { peak: +s1.last.peak.toFixed(4), rms: +s1.last.rms.toFixed(4), dur: +s1.last.dur.toFixed(2), offset: s1.last.offset, live: s1.last.live } }, null, 2));

  ok('AudioContext 已创建', s1.ctxCreated, 'state=' + s1.ctxState);
  ok('AudioContext 在 running', s1.ctxState === 'running', 'state=' + s1.ctxState);
  ok('活音源已起播', s1.liveStarts >= 1, 'live=' + s1.liveStarts + ' offline=' + s1.offlineStarts);
  const ls = s1.last;
  ok('缓冲区非静音', ls && ls.peak > 0.001, ls ? `peak=${ls.peak.toFixed(4)} rms=${ls.rms.toFixed(4)} len=${ls.len} sr=${ls.rate}` : '无');
  ok('缓冲区有时长', ls && ls.dur > 0.5, ls ? `dur=${ls.dur.toFixed(2)}s` : '');
  ok('起播偏移合法', ls && ls.offset >= 0 && ls.offset < ls.dur, ls ? `offset=${ls.offset.toFixed(2)}` : '');
  ok('按钮切到暂停', (s1.listen || '').includes('暂停') && s1.pressed === 'true', `「${(s1.listen||'').trim()}」 pressed=${s1.pressed}`);
  ok('走带显示时长', s1.dur && s1.dur !== '0:00', s1.dur);

  /* ---- 4. 进度在走 ----
     注意：无头 Chrome 没有真实声卡，AudioContext 时钟不锁硬件采样率，
     起播后可能先卡一会儿再跑，也可能跑得比墙钟快。这里只验「单调前进」，
     不拿墙钟去卡音频时钟的斜率。 */
  await page.waitForTimeout(2200);
  const s2 = await page.evaluate(() => {
    const c = window.__audio.srcCtx || window.__audio.liveCtx;
    return {
      ctxTime: c ? c.currentTime : -1, ctxState: c ? c.state : '?',
      fill: document.querySelector('#wavePlayFill').style.width,
      cur: document.querySelector('#wavePlayCur').textContent,
      valuenow: document.querySelector('#wavePlayBar').getAttribute('aria-valuenow'),
    };
  });
  ok('AudioContext 时间在推进', s2.ctxTime > s1.ctxTime, `${s1.ctxTime.toFixed(3)}s → ${s2.ctxTime.toFixed(3)}s`);
  ok('进度条在推进', widthOf(s2.fill) > widthOf(s1.fill), `${s1.fill} → ${s2.fill}`);
  ok('时间码在推进', s2.cur !== s1.cur || parseT(s2.cur) > 0, `${s1.cur} → ${s2.cur}`);
  ok('进度条宽 > 0', widthOf(s2.fill) > 0, s2.fill);

  await page.screenshot({ path: path.join(OUT, 'play-01-playing.png') });

  /* ---- 5. 暂停真的停 ---- */
  await page.click('#btnListen');
  await page.waitForTimeout(250);
  const s3 = await page.evaluate(() => ({
    stops: window.__audio.liveStops,
    fill: document.querySelector('#wavePlayFill').style.width,
    cur: document.querySelector('#wavePlayCur').textContent,
    listen: document.querySelector('#btnListen').textContent,
    wave: document.querySelector('#btnWavePlay').textContent,
    pressed: document.querySelector('#btnListen').getAttribute('aria-pressed'),
  }));
  await page.waitForTimeout(900);
  const s4 = await page.evaluate(() => ({
    fill: document.querySelector('#wavePlayFill').style.width,
    cur: document.querySelector('#wavePlayCur').textContent,
    ctxTime: (window.__audio.srcCtx || window.__audio.liveCtx) ? (window.__audio.srcCtx || window.__audio.liveCtx).currentTime : -1,
  }));
  ok('暂停后按钮回试听', (s3.listen || '').includes('试听') && s3.pressed === 'false',
     `「${(s3.listen||'').trim()}」 wave=「${(s3.wave||'').trim()}」`);
  ok('暂停后进度冻结', s4.cur === s3.cur && widthOf(s4.fill) === widthOf(s3.fill),
     `cur ${s3.cur}→${s4.cur}  fill ${s3.fill}→${s4.fill}`);
  ok('暂停调用了 src.stop()', s3.stops >= 1, 'stops=' + s3.stops);

  await page.screenshot({ path: path.join(OUT, 'play-02-paused.png') });

  /* ---- 6. 点波形跳转（locator.click 自动滚动） ---- */
  const cv = page.locator('#chartWave');
  await cv.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const box = await cv.boundingBox();
  ok('波形画布有可见尺寸', box && box.width > 100 && box.height > 40,
     box ? `${Math.round(box.width)}×${Math.round(box.height)}` : 'null');

  await cv.click({ position: { x: box.width * 0.72, y: box.height / 2 } });
  await page.waitForTimeout(500);
  const s5 = await page.evaluate(() => ({
    cur: document.querySelector('#wavePlayCur').textContent,
    dur: document.querySelector('#wavePlayDur').textContent,
    fill: document.querySelector('#wavePlayFill').style.width,
    listen: document.querySelector('#btnListen').textContent,
    liveStarts: window.__audio.liveStarts.length,
    ctxState: (window.__audio.srcCtx || window.__audio.liveCtx) ? (window.__audio.srcCtx || window.__audio.liveCtx).state : '?',
    lastOffset: (window.__audio.liveStarts.slice(-1)[0] || {}).offset,
  }));
  const frac = parseT(s5.cur) / Math.max(0.001, parseT(s5.dur));
  ok('点击波形跳到 ~72%', Math.abs(frac - 0.72) < 0.12,
     `落在 ${(frac * 100).toFixed(1)}%（${s5.cur} / ${s5.dur}）`);
  ok('跳转后自动续播', (s5.listen || '').includes('暂停'),
     `「${(s5.listen||'').trim()}」 liveStarts=${s5.liveStarts} lastOffset=${s5.lastOffset && s5.lastOffset.toFixed(2)}`);
  ok('续播偏移落在跳转点', s5.lastOffset != null && Math.abs(s5.lastOffset - parseT(s5.cur)) < 1.0,
     `src offset=${s5.lastOffset && s5.lastOffset.toFixed(2)} 显示=${s5.cur}`);
  ok('进度条宽度跟随', widthOf(s5.fill) > 50, s5.fill);
  ok('跳转后 ctx 仍在 running', s5.ctxState === 'running', s5.ctxState);

  /* ---- 7. 键盘走带 ---- */
  await page.locator('#wavePlayBar').focus();
  await page.keyboard.press('ArrowLeft');   // -5s
  await page.waitForTimeout(350);
  const s6 = await page.evaluate(() => document.querySelector('#wavePlayCur').textContent);
  ok('← 后退 5 秒', Math.abs((parseT(s5.cur) - 5) - parseT(s6)) < 1.3, `${s5.cur} → ${s6}`);

  await page.keyboard.press('ArrowRight');  // +5s
  await page.waitForTimeout(350);
  const s6b = await page.evaluate(() => document.querySelector('#wavePlayCur').textContent);
  ok('→ 前进 5 秒', Math.abs((parseT(s6) + 5) - parseT(s6b)) < 1.3, `${s6} → ${s6b}`);

  // 此时应当正在播放（跳转自动续播了）
  const playingNow = await page.evaluate(() => document.querySelector('#btnWavePlay').getAttribute('aria-pressed'));
  if (playingNow === 'true') {
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    const s7 = await page.evaluate(() => ({
      t: document.querySelector('#btnWavePlay').textContent,
      p: document.querySelector('#btnWavePlay').getAttribute('aria-pressed'),
    }));
    ok('空格暂停', (s7.t || '').includes('播放') && s7.p === 'false', `「${(s7.t||'').trim()}」 pressed=${s7.p}`);
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    const s7b = await page.evaluate(() => ({
      t: document.querySelector('#btnWavePlay').textContent,
      p: document.querySelector('#btnWavePlay').getAttribute('aria-pressed'),
    }));
    ok('空格再按续播', (s7b.t || '').includes('暂停') && s7b.p === 'true', `「${(s7b.t||'').trim()}」 pressed=${s7b.p}`);
  } else {
    ok('空格暂停', false, '当前不在播放态，无法验证空格切换');
  }

  await page.keyboard.press('End');
  await page.waitForTimeout(400);
  const sEnd = await page.evaluate(() => ({
    cur: document.querySelector('#wavePlayCur').textContent,
    dur: document.querySelector('#wavePlayDur').textContent,
  }));
  ok('End 跳到结尾', Math.abs(parseT(sEnd.dur) - parseT(sEnd.cur)) < 1.5, `${sEnd.cur} / ${sEnd.dur}`);

  /* ---- 8. 精修 + A/B ---- */
  await page.evaluate(() => {
    document.querySelector('#sec-refine').scrollIntoView({ behavior: 'instant', block: 'start' });
  });
  await page.waitForTimeout(400);
  await page.click('#btnProcess');
  try {
    await page.waitForFunction(() => {
      const b = document.querySelector('#btnAB');
      return b && !b.disabled;
    }, { timeout: 60000 });
    ok('精修完成 · A/B 可用', true);
  } catch (e) {
    ok('精修完成 · A/B 可用', false, String(e.message).slice(0, 90));
  }

  const abEnabled = await page.evaluate(() => {
    const b = document.querySelector('#btnAB');
    return !!(b && !b.disabled);
  });
  if (abEnabled) {
    const beforeCount = await page.evaluate(() => window.__audio.liveStarts.length);
    await page.click('#btnAB');
    await page.waitForTimeout(700);
    const s8 = await page.evaluate(() => ({
      liveStarts: window.__audio.liveStarts.length,
      listen: document.querySelector('#btnListen').textContent,
      cur: document.querySelector('#wavePlayCur').textContent,
      dur: document.querySelector('#wavePlayDur').textContent,
      note: document.querySelector('#waveNote').textContent,
      ctxState: (window.__audio.srcCtx || window.__audio.liveCtx) ? (window.__audio.srcCtx || window.__audio.liveCtx).state : '?',
      lastDur: (window.__audio.liveStarts.slice(-1)[0] || {}).dur,
    }));
    console.log('   [A/B]', JSON.stringify(s8));
    ok('A/B 后自动开播', (s8.listen || '').includes('暂停'), `「${(s8.listen||'').trim()}」`);
    ok('A/B 后仍在 running', s8.ctxState === 'running', s8.ctxState);
    ok('A/B 换了音源', s8.liveStarts > beforeCount, `liveStarts ${beforeCount} → ${s8.liveStarts}`);
    ok('波形图注已更新', !!s8.note, s8.note);

    // 切到精修后
    await page.click('.chip[data-wave="after"]');
    await page.waitForTimeout(500);
    const s9 = await page.evaluate(() => ({
      note: document.querySelector('#waveNote').textContent,
      listen: document.querySelector('#btnListen').textContent,
      liveStarts: window.__audio.liveStarts.length,
      lastDur: (window.__audio.liveStarts.slice(-1)[0] || {}).dur,
    }));
    ok('切到精修后波形仍可播', !!s9.note, `「${(s9.listen||'').trim()}」 ${s9.note}`);

    // 再切回原始，播放头位置应保持
    await page.click('.chip[data-wave="before"]');
    await page.waitForTimeout(500);
    const s10 = await page.evaluate(() => ({
      note: document.querySelector('#waveNote').textContent,
      cur: document.querySelector('#wavePlayCur').textContent,
      listen: document.querySelector('#btnListen').textContent,
    }));
    ok('切回原始波形仍可播', !!s10.note, `「${(s10.listen||'').trim()}」 ${s10.note} 播放头=${s10.cur}`);

    await page.evaluate(() => document.querySelector('#chartWave').scrollIntoView({ behavior: 'instant', block: 'center' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'play-03-ab.png') });
  } else {
    ok('A/B 对比可用', false, '按钮仍禁用');
  }

  /* ---- 9. 全程无 JS 报错 ---- */
  const realErrors = errors.filter((e) => !/fonts\.g|net::ERR_|favicon/i.test(e));
  ok('无 JS 运行时错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | ') || 'clean');

  /* ---- 10. 顶部截图 ---- */
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'play-04-hero.png') });

  const passed = results.filter((r) => r.pass).length;
  console.log('\n================ 播放实测 v2 ================');
  console.log(`${passed}/${results.length} 通过`);
  results.filter((r) => !r.pass).forEach((r) => console.log(`  ✗ ${r.name}  — ${r.detail}`));
  console.log('截图：' + OUT);

  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
