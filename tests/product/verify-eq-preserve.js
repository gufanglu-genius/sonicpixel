/* 问题6 验证：切换素材类型不得吃掉手动 EQ
   路径 ① 未手动 → 切换：tag 保持「按处方预置」，状态条不提保留
   路径 ② 手动改 EQ → 切换：10 档数值原样、tag 仍「已手动调整」、状态条注明「手动 EQ 保留」
   路径 ③ 刷新恢复 eqManual → 再切换：仍然保留（存盘把 eqManual 带过去了） */
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';

(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('C:' + m.text()); });

  let pass = 0, fail = 0;
  const ok = (c, n, d) => { c ? (pass++, console.log(`  ✓ ${n} — ${d}`)) : (fail++, console.log(`  ✗ ${n} — ${d}`)); };

  const read = () => p.evaluate(() => ({
    tag: document.querySelector('#eqTag')?.textContent.trim(),
    vals: [...document.querySelectorAll('.eq-band input')].map(i => i.value),
    status: document.querySelector('#dropStatus')?.textContent.trim(),
    activeKind: document.querySelector('#sourceKind .chip[aria-checked="true"]')?.textContent.trim(),
  }));
  const switchKind = () => p.evaluate(() => {
    const chips = [...document.querySelectorAll('#sourceKind .chip')];
    const cur = chips.findIndex(c => c.getAttribute('aria-checked') === 'true');
    const next = chips[cur === 0 ? 1 : 0];
    next.click();
    return next.textContent.trim();
  });

  // 合成示例：体检快，处方/EQ 齐全
  await p.goto('http://127.0.0.1:8080/?fresh=1&synth=1', { waitUntil: 'networkidle' });
  // ?synth=1 只在「试跑示例」的 runDemo 里生效，要先点按钮
  await p.click('#btnDemo');
  // eq-bands 在体检完成前就会先建好，真正就绪的信号是素材类型 chips（处方生成完）
  await p.waitForFunction(() =>
    document.querySelectorAll('#sourceKind .chip').length === 2 &&
    document.querySelectorAll('.eq-band input').length === 10
  , null, { timeout: 60000 });

  // ① 未手动 → 切换
  const s0 = await read();
  const k1 = await switchKind();
  await p.waitForTimeout(300);
  const s1 = await read();
  ok(s0.tag === '按处方预置', '① 切换前是处方预置', s0.tag);
  ok(s1.tag === '按处方预置', '① 未手动时切换后 tag 不变', s1.tag);
  ok(!/手动 EQ 保留/.test(s1.status), '① 未手动时状态条不提保留', s1.status);
  ok(s1.vals.join() === s0.vals.join(), '① 未手动时 EQ 值不变', s1.vals.join(','));

  // ② 手动改一档 → 切换
  await p.evaluate(() => {
    const inp = document.querySelectorAll('.eq-band input')[0];
    inp.value = '55';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const s2 = await read();
  ok(s2.tag === '已手动调整', '② 手动改后 tag 变更', s2.tag);
  const k2 = await switchKind();
  await p.waitForTimeout(300);
  const s3 = await read();
  ok(s3.vals[0] === '55' && s3.vals.join() === s2.vals.join(), '② 切换后 10 档原样保留', s3.vals.join(','));
  ok(s3.tag === '已手动调整', '② 切换后 tag 仍是手动', s3.tag);
  ok(/手动 EQ 保留/.test(s3.status), '② 状态条注明手动 EQ 保留', s3.status);
  console.log(`   切换 ${k1} → 手动 → 切换 ${k2}，状态：${s3.status}`);

  // 存盘 400ms 防抖，且 saveStatus 文案每次保存都一样（没法靠文案变化判断本次存没存）。
  // 手动改 EQ 与切换素材类型各排了一次存——等 1.5s 让防抖落库再刷新。
  await p.waitForTimeout(1500);

  // ③ 刷新恢复（必须去掉 ?fresh=1——它每次加载都清 IndexedDB，恢复无从谈起）
  await p.goto('http://127.0.0.1:8080/?synth=1', { waitUntil: 'networkidle' });
  await p.waitForFunction(() =>
    document.querySelector('#eqTag')?.textContent.trim() === '已手动调整' &&
    document.querySelectorAll('.eq-band input').length === 10 &&
    document.querySelectorAll('.eq-band input')[0].value === '55' &&
    document.querySelectorAll('#sourceKind .chip').length === 2
  , null, { timeout: 60000 });
  const s4 = await read();
  ok(s4.tag === '已手动调整' && s4.vals[0] === '55', '③ 恢复后手动标记与数值都在', `${s4.tag} / ${s4.vals[0]}`);
  await switchKind();
  await p.waitForTimeout(300);
  const s5 = await read();
  ok(s5.vals[0] === '55' && s5.tag === '已手动调整', '③ 恢复后再切换仍保留', `${s5.tag} / ${s5.vals[0]}`);
  ok(/手动 EQ 保留/.test(s5.status), '③ 恢复后状态条仍注明保留', s5.status);

  console.log(`\n${pass} 通过 / ${fail} 失败 · 报错 ${errs.length}`);
  errs.slice(0, 8).forEach(e => console.log('  !', e));
  await b.close();
  process.exit(fail || errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
