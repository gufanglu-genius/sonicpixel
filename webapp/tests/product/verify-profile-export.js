/* 问题8 交付面：导出的音乐档案 JSON 必须带大/小调字段
   （UI 上的表盘/状态条 verify-tonality.js 已覆盖，这里验导出文件本身） */
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';

(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('C:' + m.text()); });
  let pass = 0, fail = 0;
  const ok = (c, n, d) => { c ? (pass++, console.log(`  ✓ ${n} — ${d}`)) : (fail++, console.log(`  ✗ ${n} — ${d}`)); };

  await p.goto('http://127.0.0.1:8080/?fresh=1', { waitUntil: 'networkidle' });
  await p.click('#btnDemo');
  await p.waitForFunction(() => document.querySelector('#mBpm')?.textContent.trim() !== '—', null, { timeout: 180000 });
  await p.waitForTimeout(800);

  const [dl] = await Promise.all([
    p.waitForEvent('download', { timeout: 30000 }),
    p.click('#btnExportProfile'),
  ]);
  const f = await dl.createReadStream();
  let txt = '';
  for await (const chunk of f) txt += chunk;
  const prof = JSON.parse(txt);
  const id = prof.identity || prof.profile?.identity || {};
  console.log('  identity keys:', Object.keys(id).join(', '));

  ok(id.tonality_name === '小调' || id.tonalityName === '小调', '档案带 tonality_name=小调',
    `tonality_name=${id.tonality_name} tonalityName=${id.tonalityName}`);
  ok(!!id.western_key && /小调|大调/.test(id.western_key), '档案带 western_key', String(id.western_key));
  ok(typeof id.tonality_confidence === 'number' || typeof id.tonalityConfidence === 'number',
    '档案带 tonality_confidence', String(id.tonality_confidence ?? id.tonalityConfidence));
  ok(!!id.mode_name, '五声调式名仍在', String(id.mode_name));
  ok(!!id.time_signature || !!id.meter, '拍号字段仍在', String(id.time_signature ?? id.meter));

  console.log(`\n${pass} 通过 / ${fail} 失败 · 报错 ${errs.length}`);
  errs.slice(0, 8).forEach(e => console.log('  !', e));
  await b.close();
  process.exit(fail || errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
