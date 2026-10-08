// 示例曲链路回归：合成 → 24位入库 → 恢复
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const U = 'http://127.0.0.1:8080/';
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  let fail = 0; const ok = (c,n,d)=>{ if(!c)fail++; console.log(`${c?'  ✓':'  ✗'} ${n}${d?'  — '+d:''}`); };
  p.on('pageerror', e => console.log('PAGE-ERROR:', e.message));
  p.on('console', m => { if (m.type()==='error') console.log('CONSOLE:', m.text()); });

  await p.goto(U + '?fresh=1&synth=1', { waitUntil: 'networkidle' });
  await p.click('#btnDemo');
  await p.waitForFunction(() => document.querySelector('#mBpm').textContent.trim() !== '—', { timeout: 60000 });
  const bpm1 = await p.textContent('#mBpm');
  const dropAfterCheck = await p.evaluate(() => document.querySelector('#dropStatus').textContent.trim());
  await p.click('#btnProcess');
  await p.waitForFunction(
    () => !document.querySelector('#btnProcess').disabled
       && !document.querySelector('#btnExportProcessed').disabled,
    { timeout: 60000 });
  await p.waitForFunction(() => /已自动存盘/.test(document.querySelector('#saveStatus').textContent), { timeout: 30000 });
  const s1 = await p.evaluate(() => ({
    save: document.querySelector('#saveStatus').textContent.trim(),
    dur: document.querySelector('#mDur').textContent.trim(),
  }));
  ok(/五声调式合成/.test(dropAfterCheck), '合成示例（?synth=1）已体检', dropAfterCheck);
  console.log('   ', s1.save);

  await p.goto(U, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => /已恢复上次工作区/.test(document.querySelector('#dropStatus').textContent), { timeout: 60000 });
  const s2 = await p.evaluate(() => ({
    drop: document.querySelector('#dropStatus').textContent.trim(),
    bpm: document.querySelector('#mBpm').textContent.trim(),
    dur: document.querySelector('#mDur').textContent.trim(),
    proc: !document.querySelector('#btnExportProcessed').disabled,
  }));
  ok(/五声调式合成/.test(s2.drop), '合成示例工作区已恢复', s2.drop);
  ok(s2.bpm === bpm1.trim() && s2.dur === s1.dur, 'BPM/时长与恢复前一致', `${s2.bpm} / ${s2.dur}`);
  ok(s2.proc, '精修状态一并恢复');

  // 恢复的示例还能继续跑完整链
  ok(await p.evaluate(() => document.querySelector('#btnProcess').textContent === '重新精修'),
     '恢复后按钮文案是「重新精修」');
  await p.click('#btnRender');
  await p.waitForFunction(() => document.querySelector('#btnRender').textContent === '重新渲染', { timeout: 60000 });
  ok(true, '恢复后可继续渲染');

  console.log('\n' + (fail ? `失败 ${fail} 项` : '示例链路全绿'));
  await b.close(); process.exit(fail?1:0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
