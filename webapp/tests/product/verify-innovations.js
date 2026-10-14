/* 第一梯队创新验证（真浏览器 · 合成示例）
   ① 证据链：5 页签、指标块点击联动、各页签实线 + 证据图有像素
   ② 响度合规：平台目标 chips、精修后实测、导出如实报「实测/目标」
   ③ 等响盲听：随机分配、A/B 切换、揭晓、选择、退出归位
   ④ 结构重排：重复/删除/前移/合并、应用后时长真的变、还原按钮亮
   ⑤ 五调式互转：试听标签出现真实映射信息
   ⑥ 有据 AI：设置弹窗、测试连接（mock /models）、流式问答（mock SSE）、
      引用 chips、错误路径、刷新后 Key 仍在
   前置：python3 -m http.server 8080（webapp 目录）
   退出码 0=全绿 / 1=有失败 */
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';

(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const ctx = await b.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('P:' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('C:' + m.text()); });

  let pass = 0, fail = 0;
  const ok = (c, n, d) => { c ? (pass++, console.log(`  ✓ ${n} — ${d}`)) : (fail++, console.log(`  ✗ ${n} — ${d}`)); };
  const txt = (sel) => p.evaluate((s) => document.querySelector(s)?.textContent.trim() ?? null, sel);
  const disabled = (sel) => p.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? !!el.disabled : null;
  }, sel);

  try {
    /* ---- 启动：合成示例（快、确定） ---- */
    await p.goto('http://127.0.0.1:8080/?fresh=1&synth=1', { waitUntil: 'networkidle' });
    await p.click('#btnDemo');
    await p.waitForFunction(() =>
      document.querySelectorAll('#sourceKind .chip').length === 2 &&
      document.querySelectorAll('#evTabs .chip').length === 5
    , null, { timeout: 90000 });

    /* ================= ① 证据链 ================= */
    console.log('① 证据链');
    const ev0 = await p.evaluate(() => ({
      tabs: [...document.querySelectorAll('#evTabs .chip')].map((c) => c.textContent),
      active: document.querySelector('#evTabs .chip.is-active')?.textContent,
      lines: document.querySelectorAll('#evLines .ev-line').length,
      painted: (() => {
        const cv = document.querySelector('#chartEvidence');
        if (!cv || !cv.width) return false;
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        for (let i = 3; i < d.length; i += 160) if (d[i] > 0) return true;
        return false;
      })(),
      lufs: document.querySelector('#mLufs')?.textContent.trim(),
    }));
    ok(ev0.tabs.length === 5, '5 个证据页签', ev0.tabs.join('/'));
    ok(ev0.lines > 0, '默认页签有证据行', `${ev0.lines} 行`);
    ok(ev0.painted, '证据图画了像素', `canvas ${ev0.painted}`);
    ok(!!ev0.lufs && !/—/.test(ev0.lufs) && /LUFS/.test(ev0.lufs), '整体响度已实测', ev0.lufs);

    // 切到响度页签，再点 BPM 指标块 → 应切回 BPM（证明指标块联动）
    await p.click('#evTabs .chip:nth-child(5)');
    const tabLufs = await p.evaluate(() => document.querySelectorAll('#evLines .ev-line').length);
    const lufsLines = await p.evaluate(() =>
      [...document.querySelectorAll('#evLines .ev-line')].map((l) => l.textContent));
    ok(tabLufs > 0 && lufsLines.some((t) => /LUFS/.test(t)),
      '响度页签有门限后实测行', lufsLines[0] || '空');
    await p.click('.metric-ev[data-ev="bpm"]');
    await p.waitForTimeout(250);
    const activeAfter = await p.evaluate(() =>
      document.querySelector('#evTabs .chip.is-active')?.textContent);
    ok(activeAfter === 'BPM', '点 BPM 指标块联动到 BPM 页签', String(activeAfter));

    // 各页签逐个点开：行非空、图有像素
    for (const name of ['拍号', '调式', '大小调']) {
      await p.click(`#evTabs .chip:text-is("${name}")`);
      await p.waitForTimeout(150);
      const r = await p.evaluate(() => {
        const cv = document.querySelector('#chartEvidence');
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let painted = false;
        for (let i = 3; i < d.length; i += 160) if (d[i] > 0) { painted = true; break; }
        return {
          lines: document.querySelectorAll('#evLines .ev-line').length,
          painted,
          first: document.querySelector('#evLines .ev-line')?.textContent || '',
        };
      });
      ok(r.lines > 0 && r.painted, `「${name}」页签有行有图`,
        `${r.lines} 行 · ${r.painted ? '有像素' : '空白'} · ${r.first.slice(0, 46)}`);
    }

    /* ================= ② 响度合规 ================= */
    console.log('② 响度合规导出');
    await p.click('#lufsTargets .chip[data-lufs-target="spotify"]');
    const st1 = await txt('#lufsState');
    ok(/目标 -14/.test(st1), '选 Spotify 目标写进状态', st1);

    await p.click('#btnProcess');
    await p.waitForFunction(() =>
      /精修后/.test(document.querySelector('#lufsState')?.textContent || '')
    , null, { timeout: 90000 });
    const st2 = await txt('#lufsState');
    ok(/原曲 .*精修后 .*目标 -14/.test(st2), '精修后实测响度入档', st2);

    const dlP = p.waitForEvent('download', { timeout: 20000 });
    await p.click('#btnExportProcessed');
    const dl = await dlP;
    ok(/精修.*\.wav/.test(dl.suggestedFilename()), '导出精修 WAV', dl.suggestedFilename());
    const expStatus = await txt('#dropStatus');
    ok(/实测 .*LUFS/.test(expStatus) && /目标 -14/.test(expStatus),
      '导出状态如实报实测与目标', expStatus);

    /* ================= ③ 等响盲听 ================= */
    console.log('③ 等响盲听 A/B');
    ok(await disabled('#btnBlindStart') === false, '精修后盲听按钮可用', 'enabled');
    await p.click('#btnBlindStart');
    await p.waitForFunction(() =>
      /等响/.test(document.querySelector('#blindTag')?.textContent || '')
    , null, { timeout: 30000 });
    const blindTag = await txt('#blindTag');
    ok(/等响 .*LUFS/.test(blindTag), '开始后报等响对齐值', blindTag);
    ok(await disabled('#blindB') === false, 'A/B 可切换', 'enabled');

    await p.click('#blindB');
    await p.waitForTimeout(120);
    const bPressed = await p.evaluate(() =>
      document.querySelector('#blindB')?.getAttribute('aria-pressed'));
    ok(bPressed === 'true', '点 B 后 B 为按下态', String(bPressed));

    await p.click('#btnBlindReveal');
    await p.waitForTimeout(120);
    const revealTag = await txt('#blindTag');
    ok(/A = (原始|精修)/.test(revealTag) && /B = (原始|精修)/.test(revealTag),
      '揭晓后公布映射', revealTag);
    const resultHidden = await p.evaluate(() =>
      document.querySelector('#blindResult')?.hidden);
    ok(resultHidden === false, '选择区出现', 'hidden=' + resultHidden);

    await p.click('#btnPickA');
    await p.waitForTimeout(120);
    const pickTag = await txt('#blindPickTag');
    ok(/你选的 A = (原始版|精修版)/.test(pickTag), '选择写明 A 对应版本', pickTag);

    await p.click('#btnBlindStop');
    await p.waitForTimeout(120);
    const stopTag = await txt('#blindTag');
    const aDisabled = await disabled('#blindA');
    ok(stopTag === '未开始' && aDisabled === true, '退出后归位', `${stopTag} / A disabled=${aDisabled}`);

    /* ================= ⑤ 五调式互转 ================= */
    console.log('⑤ 五调式互转试听');
    const mel0 = await txt('#melodyAuditionTag');
    await p.click('#btnMelodyAudition');
    await p.waitForFunction((t) => {
      const el = document.querySelector('#melodyAuditionTag');
      return el && el.textContent.trim() !== t && !/合成中/.test(el.textContent);
    }, mel0, { timeout: 30000 });
    const mel1 = await txt('#melodyAuditionTag');
    ok(/\d+ 音/.test(mel1) && /(→|原样重放)/.test(mel1),
      '试听标签带真实映射', `${mel0} → ${mel1}`);

    /* ================= ④ 结构重排 ================= */
    console.log('④ 结构可编辑');
    let n = await p.evaluate(() => document.querySelectorAll('#structPlan .chip').length);
    ok(n >= 1, '结构计划已生成', `${n} 段`);
    if (n < 2) { await p.click('#btnStructDup'); n = await p.evaluate(() => document.querySelectorAll('#structPlan .chip').length); }

    await p.click('#btnStructDup');
    let n1 = await p.evaluate(() => document.querySelectorAll('#structPlan .chip').length);
    ok(n1 === n + 1, '重复此段', `${n} → ${n1}`);
    await p.click('#btnStructDel');
    n1 = await p.evaluate(() => document.querySelectorAll('#structPlan .chip').length);
    ok(n1 === n, '删除此段回退', `${n1}`);
    // 前移：选第 2 段 → 前移 → 选中应落到第 1 段
    await p.click(`#structPlan .chip:nth-child(2)`);
    await p.click('#btnStructLeft');
    const selIdx = await p.evaluate(() =>
      [...document.querySelectorAll('#structPlan .chip')].findIndex((c) => c.classList.contains('is-sel')));
    ok(selIdx === 0, '前移改变选中位', `sel=${selIdx}`);
    // 合并：选第 1 段与后段合并
    await p.click(`#structPlan .chip:nth-child(1)`);
    await p.click('#btnStructMerge');
    n1 = await p.evaluate(() => document.querySelectorAll('#structPlan .chip').length);
    ok(n1 === n - 1, '与后段合并', `${n} → ${n1}`);
    const stAfterOps = await txt('#structState');
    ok(/合并/.test(stAfterOps), '操作如实记进状态', stAfterOps);
    ok(await disabled('#btnStructApply') === false, '有改动后应用按钮亮', 'enabled');

    // 应用后时长必须真的变：合成示例只有 1 段（整曲），
    // 删除拼不出更短的计划，重复让整段翻倍才是确定的时长变化
    n1 = await p.evaluate(() => document.querySelectorAll('#structPlan .chip').length);
    if (n1 < 2) { await p.click('#btnStructDup'); n1 += 1; }
    const durBefore = parseFloat(await txt('#mDur'));
    await p.click('#btnStructApply');
    await p.waitForFunction(() =>
      /已应用/.test(document.querySelector('#structState')?.textContent || '')
    , null, { timeout: 90000 });
    const durAfter = parseFloat(await txt('#mDur'));
    const structSt = await txt('#structState');
    ok(durAfter > durBefore + 1, '应用后时长真的变（整段翻倍）', `${durBefore}s → ${durAfter}s`);
    ok(/已应用/.test(structSt), '状态报应用详情', structSt);
    const resetDis = await disabled('#btnStructReset');
    ok(resetDis === false, '历史入档后还原按钮亮', 'disabled=' + resetDis);

    /* ================= ⑥ 有据 AI ================= */
    console.log('⑥ 有据 AI（MiMo · mock 接口）');
    await p.click('#btnAiSettings');
    ok(await p.isVisible('#aiModal'), '设置弹窗打开', 'visible');
    await p.fill('#aiBaseUrl', 'https://api.xiaomimimo.com/v1');
    await p.fill('#aiKey', 'sk-test-innovations');
    await p.fill('#aiModel', 'mimo-v2.6-flash');

    await p.route('**/v1/models', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'mimo-v2.6-flash' }, { id: 'mimo-v2-flash' }] }),
    }));
    await p.click('#btnAiTest');
    await p.waitForFunction(() =>
      /连接正常/.test(document.querySelector('#aiTestTag')?.textContent || '')
    , null, { timeout: 15000 });
    const testTag = await txt('#aiTestTag');
    ok(/连接正常 · 2 个模型/.test(testTag), '测试连接读到模型列表', testTag);

    await p.click('#btnAiSave');
    await p.waitForTimeout(120);
    const aiState = await txt('#aiState');
    ok(/已配置/.test(aiState), '保存后状态条显示已配置', aiState);
    await p.click('#btnAiClose');
    ok(await p.evaluate(() => document.querySelector('#aiModal')?.hidden) === true,
      '弹窗关闭', 'hidden');

    // 卷宗必须来自实测
    const dossier = await txt('#aiDossier');
    ok(/"bpm"/.test(dossier) && /"L1"/.test(dossier) && /"结构"/.test(dossier),
      'AI 卷宗由实测数据构成', (dossier || '').slice(0, 40).replace(/\n/g, ' ') + '…');

    // 流式问答（SSE mock）。顺带截获请求体，锁死消息打包契约：
    // system 只能是引用规则，卷宗只能垫在本轮 user 消息里——
    // 两者一旦混装，「必须只引用实测数据」的规则就会被数据块冲掉
    let captured = null;
    await p.route('**/chat/completions', (route) => {
      try { captured = route.request().postDataJSON(); } catch (_) {}
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: [
          'data: {"choices":[{"delta":{"content":"本曲实测速度见下。"}}]}',
          '',
          'data: {"choices":[{"delta":{"content":"〔引用：L1.bpm〕"}}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      });
    });
    await p.fill('#aiInput', '这首曲子多快？');
    await p.click('#btnAiSend');
    await p.waitForFunction(() =>
      document.querySelectorAll('#aiLog .ai-bubble').length >= 2 &&
      document.querySelectorAll('#aiLog .ai-cite').length > 0
    , null, { timeout: 20000 });
    const ai = await p.evaluate(() => ({
      user: document.querySelector('#aiLog .ai-bubble.is-user')?.textContent || '',
      bot: document.querySelector('#aiLog .ai-bubble:not(.is-user)')?.textContent || '',
      cites: [...document.querySelectorAll('#aiLog .ai-cite')].map((c) => c.textContent),
      state: document.querySelector('#aiState')?.textContent || '',
    }));
    ok(/这首曲子多快/.test(ai.user), '用户气泡入列', ai.user.slice(0, 20));
    ok(/实测速度/.test(ai.bot), '流式回答完整落泡', ai.bot.slice(0, 30));
    // 第一条 bot 气泡的原文里必须保留 〔引用：…〕——解析成 chips 之前
    // 模型输出本身就得带引用行，这是「有据可查」的最后一道证据
    ok(ai.bot.includes('〔引用：L1.bpm〕'), '首条回答原文含引用行', ai.bot.slice(-30));
    ok(ai.cites.includes('L1.bpm'), '解析出引用 chips', ai.cites.join(','));
    ok(/已回答/.test(ai.state), '状态条标已回答', ai.state);

    // 请求体打包契约：system 纯规则、卷宗只在 user
    const msgs = (captured && captured.messages) || [];
    const sys = msgs.find((m) => m.role === 'system');
    const users = msgs.filter((m) => m.role === 'user');
    const lastUser = users[users.length - 1];
    // 规则文本里提到【实测数据】这个名字是正常的（铁律 1 要指路），
    // 不允许的是把卷宗 JSON 本身（"bpm"/"素材" 这些键）装进 system
    ok(!!sys && /引用/.test(sys.content) &&
      !/"bpm"/.test(sys.content) && !/"素材"/.test(sys.content) && !/【问题】/.test(sys.content),
      'system 只放引用规则，不含卷宗数据块',
      sys ? sys.content.slice(0, 24).replace(/\n/g, ' ') + '…' : '无 system');
    ok(!!lastUser && /【实测数据】/.test(lastUser.content) &&
      /【问题】/.test(lastUser.content) && /"bpm"/.test(lastUser.content),
      '卷宗垫在本轮 user 消息里',
      lastUser ? String(lastUser.content).slice(0, 30).replace(/\n/g, ' ') + '…' : '无');
    ok(users.every((m, i) => i === users.length - 1 || !/【实测数据】/.test(m.content)),
      '历史轮次不重发卷宗', `${users.length} 条 user`);

    // 错误路径：401 → 错误气泡，不进历史
    await p.unroute('**/chat/completions');
    await p.route('**/chat/completions', (route) => route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: '无效的 API Key' } }),
    }));
    await p.fill('#aiInput', '再问一次');
    await p.click('#btnAiSend');
    await p.waitForFunction(() =>
      document.querySelector('#aiLog .ai-bubble.is-error') !== null
    , null, { timeout: 20000 });
    const errBubble = await p.evaluate(() =>
      document.querySelector('#aiLog .ai-bubble.is-error')?.textContent || '');
    ok(/请求失败/.test(errBubble) && /无效的 API Key/.test(errBubble),
      '错误如实呈现', errBubble.slice(0, 60));
    ok(await disabled('#aiInput') === false, '失败后可继续输入', 'enabled');

    /* ---- 存盘落库后刷新，验证结构历史/响度目标/Key 全部带回 ---- */
    await p.waitForTimeout(1600);   // 400ms 防抖 × 2 + 余量
    await p.goto('http://127.0.0.1:8080/?synth=1', { waitUntil: 'networkidle' });
    await p.waitForFunction(() =>
      document.querySelectorAll('#sourceKind .chip').length === 2 &&
      document.querySelectorAll('#evTabs .chip').length === 5
    , null, { timeout: 90000 });

    const durRestored = parseFloat(await txt('#mDur'));
    ok(Math.abs(durRestored - durAfter) < 0.11,
      '刷新后结构折叠出同一时长', `${durAfter}s → ${durRestored}s`);
    const resetDis2 = await disabled('#btnStructReset');
    ok(resetDis2 === false, '结构历史随存盘带回（还原可点）', 'disabled=' + resetDis2);
    const spotifyChecked = await p.evaluate(() =>
      document.querySelector('#lufsTargets .chip[data-lufs-target="spotify"]')
        ?.getAttribute('aria-checked'));
    ok(spotifyChecked === 'true', '响度目标随存盘带回', String(spotifyChecked));
    const aiState2 = await txt('#aiState');
    ok(/已配置/.test(aiState2), 'AI Key 在 localStorage 里带回', aiState2);

    // 恢复后的证据链可点可画
    await p.click('.metric-ev[data-ev="lufs"]');
    await p.waitForTimeout(250);
    const evR = await p.evaluate(() => ({
      lines: document.querySelectorAll('#evLines .ev-line').length,
      active: document.querySelector('#evTabs .chip.is-active')?.textContent,
    }));
    ok(evR.active === '响度' && evR.lines > 0, '恢复后证据链照常工作',
      `${evR.active} · ${evR.lines} 行`);

    // 带回的历史要真能用：点还原 → 时长回原曲、还原按钮归位
    await p.click('#btnStructReset');
    await p.waitForFunction((d) => {
      const el = document.querySelector('#mDur');
      return el && Math.abs(parseFloat(el.textContent) - d) < 0.11;
    }, durBefore, { timeout: 90000 });
    const durReset = parseFloat(await txt('#mDur'));
    ok(Math.abs(durReset - durBefore) < 0.11, '点还原回到原曲时长',
      `${durAfter}s → ${durReset}s（原曲 ${durBefore}s）`);
    const resetDis3 = await disabled('#btnStructReset');
    ok(resetDis3 === true, '还原后按钮归位', 'disabled=' + resetDis3);

    // 证据卡截图（tests/.gitignore 已忽略 *.png）
    await p.evaluate(() => document.querySelector('#evidenceCard')
      ?.scrollIntoView({ block: 'center' }));
    await p.waitForTimeout(400);
    await p.locator('#evidenceCard').screenshot({
      path: `${__dirname}/../shots/innovations-evidence.png`,
    });

    // ⑥ 的错误路径是刻意打的 401，控制台必然报资源失败与 [ai] 错——预期行为不算页面错误
    const fatal = errs.filter((e) =>
      !/favicon|Autoplay|AudioContext was not allowed|Failed to load resource.*401|\[ai\]/i.test(e));
    ok(fatal.length === 0, '无页面错误', fatal.length ? fatal.slice(0, 3).join(' | ') : 'clean');
  } catch (err) {
    fail++;
    console.log('  ✗ 异常中断 — ' + (err && err.message ? err.message : err));
    if (errs.length) console.log('   页面错误：' + errs.slice(0, 5).join(' | '));
  } finally {
    await b.close();
  }

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
