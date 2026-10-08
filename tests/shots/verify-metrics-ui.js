/* 看体检面板 + 处方：低频缺陷卡和 hum/smear 分开诊断有没有真显示 */
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');

const URL = 'http://127.0.0.1:8080/';
const OUT = '/tmp/sonic-shots/out';
fs.mkdirSync(OUT, { recursive: true });
const CHROME = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail != null && detail !== '' ? '  — ' + detail : ''}`);
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.click('#btnDemo', { timeout: 15000 });
  await page.waitForFunction(() => {
    const b = document.querySelector('#checkBody');
    return b && !b.hidden && document.querySelector('#mMud') &&
      !document.querySelector('#mMud').classList.contains('is-empty');
  }, { timeout: 90000 });

  /* ---- 体检面板 ---- */
  const metrics = await page.evaluate(() => {
    const g = (s) => {
      const e = document.querySelector(s);
      return e ? e.textContent.trim() : '(无)';
    };
    return {
      mud: g('#mMud'), mudSub: g('#mMudSub'),
      lra: g('#mLra'), lraSub: document.querySelector('#mLra')?.parentElement?.querySelector('.metric-sub')?.textContent.trim(),
      thd: g('#mThd'), thdLabel: document.querySelector('#mThd')?.parentElement?.querySelector('.metric-label')?.textContent.trim(),
      bpm: g('#mBpm'), meter: g('#mMeter'),
    };
  });
  console.log('   [体检]', JSON.stringify(metrics, null, 2));

  ok('低频缺陷卡出现且出数', metrics.mud !== '—' && metrics.mud !== '(无)', metrics.mud);
  ok('低频缺陷副标说清成因', /涂抹|工频|干净/.test(metrics.mudSub), metrics.mudSub);
  ok('LRA 副标已改成 1.5 秒', /1\.5/.test(metrics.lraSub || ''), metrics.lraSub);
  ok('残余指标仍叫「非谐波残余」不是 THD', metrics.thdLabel === '非谐波残余', metrics.thdLabel);
  ok('示例曲 LRA 出数', /\d/.test(metrics.lra), metrics.lra);

  /* ---- 处方 ---- */
  await page.evaluate(() => document.querySelector('#sec-refine')?.scrollIntoView({ behavior: 'instant', block: 'start' }));
  await page.waitForTimeout(500);
  const rx = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#prescription .prescription-item')].map((li) => ({
      tag: li.querySelector('b')?.textContent.trim(),
      text: li.querySelector('p')?.textContent.trim(),
    }));
    return items;
  });
  console.log('   [处方]');
  rx.forEach((r, i) => console.log(`    ${i + 1}. ${r.tag}  ${r.text}`));

  const dyn = rx.find((r) => r.tag === '动态均衡');
  ok('处方有「动态均衡」条目', !!dyn, dyn ? dyn.text.slice(0, 60) : '缺');
  ok('处方不再用旧词「浑浊度 X%」', !rx.some((r) => /浑浊度\s*\d/.test(r.text)),
    rx.filter((r) => /浑浊/.test(r.text)).map((r) => r.text).join(' | ') || 'clean');
  // 副标不许自相矛盾：mud ≥ 8% 时不能写「干净」
  const mudPct = parseFloat(metrics.mud);
  const claimsClean = /干净/.test(metrics.mudSub);
  ok('副标与分数不矛盾', !(claimsClean && mudPct >= 8),
    `mud=${metrics.mud} sub=${metrics.mudSub}`);
  ok('谐波条目不写「过载谐波」', !rx.some((r) => /过载谐波/.test(r.text)),
    rx.filter((r) => /谐波/.test(r.text)).map((r) => r.text.slice(0, 40)).join(' | ') || 'clean');

  await page.screenshot({ path: path.join(OUT, 'metrics-01-clean.png'), fullPage: false });
  await page.evaluate(() => document.querySelector('#checkBody')?.closest('.card,section,div')?.scrollIntoView({ behavior: 'instant', block: 'start' }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'metrics-02-checkup.png') });

  /* ---- JSON 导出字段：截住 download 出来的 Blob ---- */
  await page.evaluate(() => {
    window.__exported = null;
    const orig = URL.createObjectURL;
    URL.createObjectURL = function (b) {
      try {
        if (b && b.text) b.text().then((t) => { window.__exported = t; });
      } catch (_) {}
      return orig.call(URL, b);
    };
  });
  const exportBtn = page.locator('#btnExportProfile');
  await exportBtn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const disabled = await exportBtn.isDisabled();
  ok('导出档案按钮可用', !disabled, disabled ? 'disabled' : 'enabled');
  await exportBtn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const payload = await page.evaluate(() => {
    if (!window.__exported) return { err: 'no blob captured' };
    try {
      const j = JSON.parse(window.__exported);
      return j.quality || { err: 'no quality key', keys: Object.keys(j) };
    } catch (e) {
      return { err: 'parse fail ' + e.message };
    }
  });
  console.log('   [quality 导出]', JSON.stringify(payload));
  ok('导出含 mud_score', Number.isFinite(payload.mud_score), String(payload.mud_score));
  ok('导出含 mud_smear', Number.isFinite(payload.mud_smear), String(payload.mud_smear));
  ok('导出含 hum_score', Number.isFinite(payload.hum_score), String(payload.hum_score));
  ok('导出含 hum_freq', Number.isFinite(payload.hum_freq), String(payload.hum_freq));
  ok('导出 thd 恒为 null（不冒充谐波失真）', payload.thd === null, String(payload.thd));

  const realErrors = errors.filter((e) => !/fonts\.g|net::ERR_|favicon/i.test(e));
  ok('无 JS 报错', realErrors.length === 0, realErrors.slice(0, 3).join(' | ') || 'clean');

  const passed = results.filter((r) => r.pass).length;
  console.log('\n================ UI 指标实测 ================');
  console.log(`${passed}/${results.length} 通过`);
  results.filter((r) => !r.pass).forEach((r) => console.log(`  ✗ ${r.name}  — ${r.detail}`));
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
