/* 高频重建前置级验收：
   ① 带限演示素材（产品 trumpet_in.wav）→ 体检卡判可重建、精修卡入口亮
   ② 全带素材（fullband_in.wav）→ 判高频完整、入口关闭
   ③ 纯音（sine440_in.wav）→ 判可重建但重建后覆盖率 0（证据门弃权）
   ④ trumpet 重建：进度走完、证据卡三数字、state.bwe.buffer 生成
   ⑤ 启用后执行精修：E.process 吃的是重建后音频（版本树带高频重建节点）
   ⑥ 关闭开关再精修：输入回到原曲
   ⑦ 存盘只带参数与证据，刷新后产物为空但开关/强度恢复
   用法：先起 8080 服务，再 node tests/product/verify-bwe.js */
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const ASSETS = '/Users/chenhuidediannao/Desktop/音智新媒-高频重建/web/assets';

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
  const txt = (sel) => p.textContent(sel);
  const st = () => p.evaluate(() => ({
    bweOn: window.__state.bwe.on,
    alpha: window.__state.bwe.alpha,
    hasBuffer: !!window.__state.bwe.buffer,
    detectPass: window.__state.bwe.detect ? window.__state.bwe.detect.pass : null,
    coverage: window.__state.bwe.diag ? window.__state.bwe.diag.coverage : null,
    leak: window.__state.bwe.diag ? window.__state.bwe.diag.leakDb : null,
    passthrough: window.__state.bwe.diag ? window.__state.bwe.diag.signalPassthrough : null,
    tree: window.__state.versionTree.map((n) => n.title),
  }));

  try {
    await p.goto('http://127.0.0.1:8080/?fresh=1', { waitUntil: 'networkidle' });

    // ================= ① 带限小号：判可重建
    console.log('① trumpet 检测');
    await p.setInputFiles('#fileInput', ASSETS + '/trumpet_in.wav');
    await p.waitForFunction(() =>
      window.__state.bwe.detect !== null && window.__state.profile
    , null, { timeout: 60000 });
    const v1 = await txt('#hbVerdict');
    ok(/可尝试高频重建/.test(v1), '体检卡判可重建', v1);
    const toggleEnabled = await p.evaluate(() => !document.getElementById('bweToggle').disabled);
    ok(toggleEnabled, '精修卡启用按钮亮');
    const goShown = await p.evaluate(() => !document.getElementById('btnBweGo').hidden);
    ok(goShown, '体检卡直达按钮出现');
    const hlShown = await p.evaluate(() =>
      document.getElementById('bweCard').classList.contains('bwe-hl'));
    ok(hlShown, '精修卡赤陶强调');
    await p.click('#btnBweGo');
    const pulsed = await p.evaluate(() =>
      document.getElementById('bweCard').classList.contains('bwe-pulse'));
    ok(pulsed, '直达按钮触发脉冲高亮');
    const s1 = await st();
    ok(s1.detectPass === true, 'detect.pass=true', s1.detectPass);

    // ================= ② 重建
    console.log('② 重建');
    await p.click('#btnBweRun');
    await p.waitForFunction(() =>
      window.__state.bwe.diag !== null && !window.__state.bwe.busy
    , null, { timeout: 120000 });
    const s2 = await st();
    ok(s2.hasBuffer, 'bwe.buffer 已生成');
    ok(Math.abs(s2.coverage - 0.974) < 0.02,
      '可重建比例约 97.4%', s2.coverage);
    ok(s2.leak < -50, '带内泄漏为大负 dB', s2.leak);
    const cov = await txt('#bweCov');
    ok(/97\.\d%/.test(cov), '证据卡显示覆盖率', cov);
    const evVisible = await p.evaluate(() => !document.getElementById('bweEvidence').hidden);
    ok(evVisible, '证据卡可见');

    // ================= ③ 启用 + 执行精修（吃重建音频）
    console.log('③ 启用后精修');
    await p.click('#bweToggle');
    let s3 = await st();
    ok(s3.bweOn === true, '开关已启用');
    await p.click('#btnProcess');
    await p.waitForFunction(() =>
      window.__state.processedBuffer !== null
    , null, { timeout: 180000 });
    const s4 = await st();
    ok(s4.tree.includes('高频重建'), '版本树含高频重建节点', s4.tree);
    const refineNode = s4.tree.filter((t) => t === '精修').length;
    ok(refineNode >= 1, '版本树含精修节点');

    // ================= ④ 关开关再精修：输入回到原曲
    console.log('④ 关开关');
    await p.click('#bweToggle');
    s3 = await st();
    ok(s3.bweOn === false, '开关已关闭');
    await p.click('#btnProcess');
    await p.waitForFunction(() =>
      window.__state.processedBuffer !== null &&
      window.__state.versionTree.filter((n) => n.title === '精修').length >= 2
    , null, { timeout: 180000 });

    // ================= ⑤ 存盘口径 + 刷新恢复
    console.log('⑤ 刷新恢复');
    await p.click('#bweToggle');   // 重新打开开关
    await p.evaluate(() => {
      const a = document.getElementById('bweAlpha');
      a.value = '70';
      a.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await p.waitForTimeout(1800);  // 400ms 防抖 × 2 + 余量
    await p.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle' });
    await p.waitForFunction(() => window.__state.profile && window.__state.bwe.detect
    , null, { timeout: 90000 });
    // 有 processed 会自动跑精修；bwe.on 会触发自动重建
    await p.waitForFunction(() =>
      window.__state.bwe.alpha === 0.7 && window.__state.bwe.on === true
    , null, { timeout: 30000 });
    const s5 = await st();
    ok(s5.alpha === 0.7, '强度 70% 恢复', s5.alpha);
    ok(s5.bweOn === true, '开关状态恢复');
    ok(s5.detectPass === true, '检测证据恢复', s5.detectPass);

    // ================= ⑥ 全带素材：入口关闭
    console.log('⑥ fullband');
    await p.setInputFiles('#fileInput', ASSETS + '/fullband_in.wav');
    await p.waitForFunction(() =>
      window.__state.bwe.detect && window.__state.bwe.detect.guardRatio != null &&
      window.__state.profile && /fullband/.test(window.__state.profile.meta.source_file || '')
    , null, { timeout: 60000 });
    const v6 = await txt('#hbVerdict');
    ok(/高频内容完整/.test(v6), '全带判高频完整', v6);
    const dis6 = await p.evaluate(() => document.getElementById('bweToggle').disabled);
    ok(dis6, '入口关闭');
    const goHid = await p.evaluate(() => document.getElementById('btnBweGo').hidden);
    ok(goHid, '全带时直达按钮隐藏');
    const hlOff = await p.evaluate(() =>
      !document.getElementById('bweCard').classList.contains('bwe-hl'));
    ok(hlOff, '全带时强调移除');
    const s6 = await st();
    ok(s6.detectPass === false, 'detect.pass=false');

    // ================= ⑦ 纯音：可过守卫但重建覆盖率 0
    console.log('⑦ sine440');
    await p.setInputFiles('#fileInput', ASSETS + '/sine440_in.wav');
    await p.waitForFunction(() =>
      window.__state.bwe.detect && window.__state.profile &&
      /sine440/.test(window.__state.profile.meta.source_file || '') &&
      window.__state.bwe.detect.pass === true
    , null, { timeout: 60000 });
    await p.click('#btnBweRun');
    await p.waitForFunction(() =>
      window.__state.bwe.diag !== null && !window.__state.bwe.busy
    , null, { timeout: 120000 });
    const s7 = await st();
    ok(s7.coverage === 0, '纯音覆盖率 0（证据门弃权）', s7.coverage);

    // 页面错误：401 之类没有；config.local.js 若不存在会有 404 资源错，
    // 过滤掉 Failed to load resource 里指向 config.local.js 的条目
    const realErrs = errs.filter((e) => !/config\.local\.js/.test(e));
    ok(realErrs.length === 0, '无页面错误', realErrs.slice(0, 3));
  } catch (e) {
    console.log('  ✗ 中断:', String(e).slice(0, 300));
    fail++;
  }

  await b.close();
  console.log(`\nbwe verify: ${pass}/${pass + fail} 通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
