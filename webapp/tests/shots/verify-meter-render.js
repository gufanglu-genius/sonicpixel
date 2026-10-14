/* 再生认拍号：分析出 5/4 却按 4/4 写谱 = 产品自相矛盾。
   直接调 E.renderArrangement，核对 meter / beatsPerBar / 小节线落点。 */
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');

const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const URL = 'http://127.0.0.1:8080/';

(async () => {
  const browser = await chromium.launch({
    executablePath: EXEC,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(URL, { waitUntil: 'networkidle' });

  const cases = [
    { meter: '4/4', beats: 4, bars: 4 },
    { meter: '3/4', beats: 3, bars: 4 },
    { meter: '2/4', beats: 2, bars: 4 },
    { meter: '5/4', beats: 5, bars: 3 },
    { meter: '6/8', beats: 6, bars: 3 },
    { meter: '7/8', beats: 7, bars: 3 },
    { meter: '9/9', beats: 4, bars: 2 }, // 未识别 → 回落 4/4
    { meter: undefined, beats: 4, bars: 2 }, // 缺省 → 4/4
  ];

  const out = await page.evaluate(async (cases) => {
    const E = window.SonicEngine;
    const rows = [];
    for (const c of cases) {
      const res = await E.renderArrangement({
        rootMidi: 60, modeIndex: 0, bpm: 100, bars: c.bars,
        muted: {}, seed: 7,
        ...(c.meter ? { meter: c.meter } : {}),
      });
      const beatSec = 60 / 100;
      // 小节线：lead 事件的 t 应整除 (beatsPerBar * beatSec) 后落点在小节首拍
      const lead = res.events.filter((e) => e.track === 'lead').map((e) => e.t);
      const barSec = res.beatsPerBar * beatSec;
      const offGrid = lead.filter((t) => Math.abs((t / beatSec) - Math.round(t / beatSec)) > 1e-6).length;
      // 鼓：强拍（accent>=0.75）落在每小节第 1 拍
      const drums = res.events.filter((e) => e.track === 'drums').map((e) => e.t);
      const barFirsts = [];
      for (let bar = 0; bar < c.bars; bar++) barFirsts.push(bar * barSec);
      const hasDownbeat = barFirsts.every((t0) => drums.some((d) => Math.abs(d - t0) < 1e-6));
      rows.push({
        asked: c.meter ?? '(缺省)',
        got: res.meter,
        beats: res.beatsPerBar,
        wantBeats: c.beats,
        bars: c.bars,
        events: res.events.length,
        lead: lead.length,
        offGrid,
        hasDownbeat,
        barSec: Math.round(barSec * 1000) / 1000,
        duration: Math.round(res.duration * 1000) / 1000,
      });
    }
    return rows;
  }, cases);

  let pass = 0, fail = 0;
  const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log(`  ✓ ${name}  — ${detail}`); }
    else { fail++; console.log(`  ✗ ${name}  — ${detail}`); }
  };

  console.log('================ 再生认拍号 ================');
  for (const r of out) {
    const detail = `问 ${r.asked} → 写 ${r.got}/${r.beats}拍 · ${r.events} 事件 · 小节 ${r.barSec}s · 落拍 ${r.offGrid === 0 ? '齐' : r.offGrid + ' 偏'}`;
    const expectBeats = r.asked === '9/9' || r.asked === '(缺省)' ? 4 : r.wantBeats;
    ok(r.got === (r.asked === '9/9' || r.asked === '(缺省)' ? '4/4' : r.asked)
        && r.beats === expectBeats
        && r.offGrid === 0
        && r.hasDownbeat,
      `${r.asked} → ${r.got}`, detail);
  }

  // 小节线对齐：4 拍号下 barSec = beats * 0.6
  const barOk = out.every((r) => Math.abs(r.barSec - r.beats * 0.6) < 1e-6);
  ok(barOk, '小节长度 = 拍数 × 拍长', out.map((r) => `${r.got}:${r.barSec}s`).join(' '));

  // 5/4 与 4/4 的小节线必须不同
  const b4 = out.find((r) => r.asked === '4/4');
  const b5 = out.find((r) => r.asked === '5/4');
  ok(b5.barSec !== b4.barSec, '5/4 小节线 ≠ 4/4', `4/4=${b4.barSec}s 5/4=${b5.barSec}s`);

  // 拍号应写进产物（app.js 会拿去冒充 authored 真值）
  ok(typeof out[0].got === 'string' && out[0].got.includes('/'), '产物带 meter 字段', out[0].got);

  ok(errors.length === 0, '全程无 JS 报错', errors.length ? errors.join(' | ') : 'clean');

  console.log('─'.repeat(50));
  console.log(`${pass} 通过 / ${fail} 失败`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
