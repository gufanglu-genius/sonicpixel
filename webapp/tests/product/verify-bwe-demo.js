/* 一键体验高频重建验收：
   ① hero 与导入区两个入口按钮都在
   ② 点击后自动跑 体检 → 判可重建 → 重建 → 启用开关 → 精修
   ③ 重建覆盖率约 97.4%（与产品 trumpet 基准一致）
   ④ 版本树含高频重建与精修节点、A/B 亮、状态语提示演示完成
   ⑤ 完成落点是精修页证据卡脉冲；页面无错误
   用法：先起 8080 服务，再 node tests/product/verify-bwe-demo.js */
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';

(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('C:' + m.text()); });

  let pass = 0, fail = 0;
  const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ✓', name); }
    else { fail++; console.log('  ✗', name, extra != null ? JSON.stringify(extra) : ''); }
  };

  try {
    await p.goto('http://127.0.0.1:8080/?fresh=1', { waitUntil: 'networkidle' });

    // ================= ① 入口 =================
    console.log('① 入口');
    const heroBtn = await p.evaluate(() => {
      const el = document.getElementById('btnHeroBweDemo');
      return !!el && !el.hidden;
    });
    ok(heroBtn, 'hero 按钮在');
    const dropBtn = await p.evaluate(() => {
      const el = document.getElementById('btnBweDemo');
      return !!el && !el.hidden;
    });
    ok(dropBtn, '导入区按钮在');

    // ================= ② 一键全链 =================
    console.log('② 一键全链');
    await p.click('#btnBweDemo');
    await p.waitForFunction(() =>
      window.__state.profile && window.__state.bwe.detect !== null
    , null, { timeout: 90000 });
    const verdict = await p.textContent('#hbVerdict');
    ok(/可尝试高频重建/.test(verdict), '自动体检判可重建', verdict);

    await p.waitForFunction(() =>
      window.__state.bwe.diag !== null && !window.__state.bwe.busy &&
      window.__state.bwe.on === true
    , null, { timeout: 180000 });
    const s1 = await p.evaluate(() => ({
      on: window.__state.bwe.on,
      hasBuffer: !!window.__state.bwe.buffer,
      coverage: window.__state.bwe.diag ? window.__state.bwe.diag.coverage : null,
    }));
    ok(s1.on, '开关已自动启用');
    ok(s1.hasBuffer, '重建产物已生成');
    ok(Math.abs(s1.coverage - 0.974) < 0.02, '覆盖率约 97.4%', s1.coverage);

    // ================= ③ 精修完成与落点 =================
    console.log('③ 精修完成');
    await p.waitForFunction(() => window.__state.processedBuffer !== null
      && /演示完成/.test(document.getElementById('dropStatus').textContent)
    , null, { timeout: 180000 });
    const s2 = await p.evaluate(() => ({
      tree: window.__state.versionTree.map((n) => n.title),
      ab: !document.getElementById('btnAB').disabled,
      status: document.getElementById('dropStatus').textContent,
      pulsed: document.getElementById('bweCard').classList.contains('bwe-pulse'),
      src: window.__state.profile.meta.source_file,
    }));
    ok(s2.tree.includes('高频重建'), '版本树含高频重建节点', s2.tree);
    ok(s2.tree.filter((t) => t === '精修').length >= 1, '版本树含精修节点');
    ok(s2.ab, 'A/B 按钮可用');
    ok(/演示完成/.test(s2.status), '状态语提示演示完成', s2.status);
    ok(/带限小号/.test(s2.src || ''), '素材标注为演示小号', s2.src);
    ok(s2.pulsed, '证据卡脉冲高亮');

    // 页面错误：config.local.js 若不存在会有 404 资源错，过滤之
    const realErrs = errs.filter((e) => !/config\.local\.js/.test(e));
    ok(realErrs.length === 0, '无页面错误', realErrs.slice(0, 3));
  } catch (e) {
    console.log('  ✗ 中断:', String(e).slice(0, 300));
    fail++;
  }

  await b.close();
  console.log(`\nbwe-demo verify: ${pass}/${pass + fail} 通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
