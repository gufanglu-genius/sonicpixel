const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const FILE = '/Users/chenhuidediannao/Desktop/红头绳.wav';
const U = 'http://127.0.0.1:8080/';
const snap = () => ({
  bpm: document.querySelector('#mBpm').textContent.trim(),
  meter: document.querySelector('#mMeter').textContent.trim(),
  mode: document.querySelector('#modeName').textContent.trim(),
  dur: document.querySelector('#mDur').textContent.trim(),
  strength: document.querySelector('#strength').value,
  strengthTag: document.querySelector('#strengthTag').textContent,
  bpmOut: document.querySelector('#bpmOut').textContent,
  barsOut: document.querySelector('#barsOut').textContent,
  proc: !document.querySelector('#btnExportProcessed').disabled,
  mix: !document.querySelector('#btnExportMix').disabled,
  procLabel: document.querySelector('#btnProcess').textContent,
  renderLabel: document.querySelector('#btnRender').textContent,
  ab: !document.querySelector('#btnAB').disabled,
  tree: document.querySelectorAll('#tree .tree-node').length,
  treeTitles: [...document.querySelectorAll('#tree .tree-label')].map(e => e.textContent),
  tracks: document.querySelectorAll('#tracks .track').length,
  drop: document.querySelector('#dropStatus').textContent.trim(),
  save: document.querySelector('#saveStatus').hidden ? '' : document.querySelector('#saveStatus').textContent.trim(),
  clear: !document.querySelector('#btnClearWs').hidden,
  eq: [...document.querySelectorAll('.eq-band input')].map(i => i.value).join(','),
});

(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGE-ERROR:', e.message));
  p.on('console', m => { if (m.type() === 'error') console.log('CONSOLE:', m.text()); });
  let fail = 0;
  const ok = (c, n, d) => { if (!c) fail++; console.log(`${c ? '  ✓' : '  ✗'} ${n}${d ? '  — ' + d : ''}`); };

  // ── A. 全新启动（清库），跑完整条链 ──
  console.log('══ A. 冷启动 + 跑完整链 ══');
  await p.goto(U + '?fresh=1', { waitUntil: 'networkidle' });
  let s = await p.evaluate(snap);
  ok(s.save === '' && !s.clear, '空态无存盘提示、无清空按钮');

  await p.setInputFiles('#fileInput', FILE);
  await p.waitForFunction(() => document.querySelector('#mBpm').textContent.trim() !== '—', { timeout: 120000 });
  await p.click('#btnProcess');
  // flushSave 排在 try 末尾、finally 之前：按钮恢复可点 = 存盘已落库
  await p.waitForFunction(
    () => !document.querySelector('#btnProcess').disabled
       && !document.querySelector('#btnExportProcessed').disabled,
    { timeout: 60000 });
  await p.click('#btnRender');
  await p.waitForFunction(
    () => document.querySelector('#btnRender').textContent === '重新渲染'
       && !document.querySelector('#btnRender').disabled,
    { timeout: 60000 });
  const before = await p.evaluate(snap);
  console.log('   保存时:', before.drop, '|', before.save);
  ok(before.proc && before.mix && before.ab, '精修/混音/A-B 均可用');
  ok(before.tree >= 3, '版本树有节点', String(before.tree));

  // ── B. 刷新恢复 ──
  console.log('══ B. 不带 fresh 重新进入 → 应自动恢复 ══');
  await p.goto(U, { waitUntil: 'networkidle' });
  await p.waitForFunction(
    () => /已恢复上次工作区/.test(document.querySelector('#dropStatus').textContent),
    { timeout: 60000 });
  const after = await p.evaluate(snap);
  console.log('   恢复:', after.drop);

  // 数组得比内容：直接 === 比的是引用，永远不等
  const eqv = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const cmp = (k) => ok(eqv(before[k], after[k]), `恢复 ${k}`, `${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`);
  ['bpm','meter','mode','dur','strength','strengthTag','bpmOut','barsOut',
   'proc','mix','procLabel','renderLabel','ab','tree','treeTitles','tracks','eq'].forEach(cmp);
  ok(after.clear, '清空工作区按钮出现');
  ok(/已自动存盘/.test(after.save), '恢复后存盘提示仍在', after.save);

  // ── C. 恢复后的产物能直接用（不是只恢复了界面） ──
  console.log('══ C. 恢复后直接导出 ══');
  const path = require('path'), fs = require('fs');
  const OUT = '/tmp/sonic-shots/product/out'; fs.mkdirSync(OUT, { recursive: true });
  const [d1] = await Promise.all([p.waitForEvent('download'), p.click('#btnExportProcessed')]);
  await d1.saveAs(path.join(OUT, 'restored_' + d1.suggestedFilename()));
  const b1 = fs.readFileSync(path.join(OUT, 'restored_' + d1.suggestedFilename()));
  ok(b1.toString('ascii',0,4)==='RIFF' && b1.readUInt16LE(34)===24 && b1.readUInt32LE(40)===b1.length-44,
     '恢复后导出精修 WAV 是 24 位且长度自洽', `${d1.suggestedFilename()} ${(b1.length/1048576).toFixed(1)}MB`);

  const [d2] = await Promise.all([p.waitForEvent('download'), p.click('#btnExportMix')]);
  await d2.saveAs(path.join(OUT, 'restored_' + d2.suggestedFilename()));
  const b2 = fs.readFileSync(path.join(OUT, 'restored_' + d2.suggestedFilename()));
  ok(b2.toString('ascii',0,4)==='RIFF' && b2.readUInt16LE(34)===24 && b2.readUInt32LE(40)===b2.length-44,
     '恢复后导出混音 WAV 正常', `${d2.suggestedFilename()} ${(b2.length/1048576).toFixed(1)}MB`);

  // ── D. 参数改动会重新存盘，再次恢复一致 ──
  console.log('══ D. 改参数 → 再存 → 再恢复 ══');
  await p.evaluate(() => {
    const r = document.querySelector('#barsRange'); r.value = '4';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    const s = document.querySelector('#strength'); s.value = '80';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForFunction(
    () => document.querySelector('#barsOut').textContent === '4 小节'
       && document.querySelector('#strengthTag').textContent === '强度 80%',
    { timeout: 5000 });
  // 乐段参数变了 → 标记过期，此时不该再声称「可直接导出混音」
  const staleLabel = await p.textContent('#btnRender');
  ok(/重新渲染/.test(staleLabel), '改小节数后乐段标记过期', staleLabel);

  await p.waitForFunction(() => /已自动存盘/.test(document.querySelector('#saveStatus').textContent), { timeout: 30000 })
    .catch(() => {});
  await p.waitForTimeout(2000); // 等 400ms 去重窗口 + 落库

  await p.goto(U, { waitUntil: 'networkidle' });
  await p.waitForFunction(
    () => /已恢复上次工作区/.test(document.querySelector('#dropStatus').textContent),
    { timeout: 60000 });
  const s2 = await p.evaluate(snap);
  ok(s2.barsOut === '4 小节' && s2.strength === '80' && s2.strengthTag === '强度 80%',
     '参数变更被存盘并恢复', `${s2.barsOut} / ${s2.strengthTag}`);
  ok(/参数已修改|重新渲染/.test(s2.renderLabel), '过期标记也被恢复', s2.renderLabel);

  // ── E. 清空工作区 ──
  console.log('══ E. 清空工作区 ══');
  await p.click('#btnClearWs');
  await p.waitForFunction(() => document.querySelector('#checkBody').hidden === true, { timeout: 15000 });
  const s3 = await p.evaluate(snap);
  ok(s3.save === '' && !s3.clear, '清空后回到空态');
  await p.goto(U, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  const s4 = await p.evaluate(snap);
  ok(s4.drop === '尚未导入音频', '清空后刷新不再恢复', s4.drop);

  console.log('\n' + '═'.repeat(60));
  console.log(fail ? `失败 ${fail} 项` : '持久化全绿');
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
