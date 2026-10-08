const { chromium } = require('playwright-core');
const fs = require('fs');

const URL = 'http://127.0.0.1:8080/';
const fails = [];
const ok = (name, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  → ' + detail : ''));
  if (!cond) fails.push(name + (detail ? ' (' + detail + ')' : ''));
};

(async () => {
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PE: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('CE: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle' });

  // ---------- 1. 首轮：示例 → 精修 → 再生 → 质检 ----------
  console.log('\n== 首轮全流程 ==');
  await page.click('#btnDemo');
  await page.waitForFunction(() => !document.querySelector('#checkBody').hidden, { timeout: 60000 });

  const m1 = await page.evaluate(() => ({
    bpm: document.querySelector('#mBpm').textContent.trim(),
    meter: document.querySelector('#mMeter').textContent.trim(),
    thd: document.querySelector('#mThd').textContent.trim(),
    lra: document.querySelector('#mLra').textContent.trim(),
    mode: document.querySelector('#modeDial')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 60),
    tree: [...document.querySelectorAll('.tree-node .tree-label')].map((n) => n.textContent),
    treeConnectors: document.querySelectorAll('.tree-connector').length,
    structure: [...document.querySelectorAll('#structureLegend .legend-item, #structureLegend *')].map((n) => n.textContent.trim()).filter(Boolean).slice(0, 12),
  }));
  console.log('  metrics:', JSON.stringify(m1));
  ok('BPM 有值', /\d/.test(m1.bpm), m1.bpm);
  ok('THD 有值且非 NaN', /\d/.test(m1.thd) && !m1.thd.includes('NaN'), m1.thd);
  ok('版本树首轮 1 个版本', m1.tree.filter((t) => t !== 'origin').length === 1, m1.tree.join('/'));
  ok('无 JS 插入的连接符（CSS 画箭头）', m1.treeConnectors === 0, String(m1.treeConnectors));

  // 精修
  await page.click('#btnProcess');
  await page.waitForFunction(
    () => document.querySelector('#btnProcess').textContent.includes('重新精修')
        || document.querySelector('#btnProcess').textContent.includes('失败'),
    { timeout: 60000 }
  );
  const procLabel = await page.textContent('#btnProcess');
  ok('精修成功', procLabel.includes('重新精修'), procLabel.trim());
  ok('A/B 按钮启用', await page.isEnabled('#btnAB'));

  // 再生
  await page.click('#btnRender');
  await page.waitForFunction(
    () => document.querySelector('#btnRender').textContent.includes('重新渲染')
        || document.querySelector('#btnRender').textContent.includes('失败'),
    { timeout: 60000 }
  );
  const renderLabel = await page.textContent('#btnRender');
  ok('再生成功', renderLabel.includes('重新渲染'), renderLabel.trim());
  const noteCounts = await page.evaluate(() =>
    [...document.querySelectorAll('.track')].map((t) => ({
      name: t.querySelector('.track-name')?.textContent.trim(),
      notes: t.querySelectorAll('.track-note').length,
    })));
  console.log('  tracks:', JSON.stringify(noteCounts));
  ok('五轨都有音符', noteCounts.length === 5 && noteCounts.every((t) => t.notes > 0),
     noteCounts.map((t) => t.name + ':' + t.notes).join(' '));

  // 回流质检
  await page.click('#btnRecheck');
  await page.waitForTimeout(1200);
  const checks = await page.evaluate(() =>
    [...document.querySelectorAll('.check')].map((c) => ({
      cls: c.className,
      val: c.querySelector('.check-value')?.textContent.trim(),
    })));
  console.log('  recheck:', JSON.stringify(checks));
  ok('质检 3 项都有结论', checks.length === 3 && checks.every((c) => c.val && c.val !== '待执行'),
     checks.map((c) => c.val).join(' / '));

  // 导出档案
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.click('#btnExportProfile'),
  ]);
  const profPath = '/tmp/sonic-shots/out-regress.json';
  await dl.saveAs(profPath);
  const prof = JSON.parse(fs.readFileSync(profPath, 'utf8'));
  console.log('  export identity:', JSON.stringify(prof.identity));
  ok('导出含 source_file', !!prof.meta.source_file, String(prof.meta.source_file));
  ok('time_signature 可为 null（不硬填）',
     prof.identity.time_signature === null || /^\d+\/\d+$/.test(prof.identity.time_signature),
     String(prof.identity.time_signature));
  ok('quality 不再重复 timbre', !('spectral' in prof.quality));
  // 字段早已改名：它是「谐波外残余能量比」的覆盖率，不是谐波失真。
  // 旧键 thd_coverage 是 THD 冒充时代的遗留，产品刻意不再提供。
  ok('quality.nonharmonic_coverage 存在', 'nonharmonic_coverage' in prof.quality, String(prof.quality.nonharmonic_coverage));
  ok('quality.thd 恒为 null（不冒充谐波失真）', prof.quality.thd === null, String(prof.quality.thd));
  ok('quality 含低频缺陷分量', 'mud_smear' in prof.quality && 'hum_score' in prof.quality,
     `smear=${prof.quality.mud_smear} hum=${prof.quality.hum_score}`);
  ok('melody 带 method 说明', !!prof.melody.method, prof.melody.method);
  ok('版本树无重名“导入体检”×3',
     !(prof.provenance.versions.filter((v) => v.title === '导入体检').length > 1),
     prof.provenance.versions.map((v) => v.title).join('/'));

  // ---------- 2. 换素材：状态必须归零 ----------
  console.log('\n== 换素材后状态归零 ==');
  const before = await page.evaluate(() => ({
    tree: document.querySelectorAll('.tree-node').length,
    tracks: document.querySelectorAll('.track-note').length,
    abDisabled: document.querySelector('#btnAB').disabled,
    processLabel: document.querySelector('#btnProcess').textContent.trim(),
    renderLabel: document.querySelector('#btnRender').textContent.trim(),
  }));
  console.log('  换素材前:', JSON.stringify(before));

  await page.click('#btnHeroDemo');
  await page.waitForFunction(() => !document.querySelector('#checkBody').hidden, { timeout: 60000 });
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    tree: document.querySelectorAll('.tree-node').length,
    treeLabels: [...document.querySelectorAll('.tree-node .tree-label')].map((n) => n.textContent),
    tracks: document.querySelectorAll('.track-note').length,
    abDisabled: document.querySelector('#btnAB').disabled,
    processLabel: document.querySelector('#btnProcess').textContent.trim(),
    renderLabel: document.querySelector('#btnRender').textContent.trim(),
    checks: [...document.querySelectorAll('.check-value')].map((n) => n.textContent.trim()),
    waveNote: document.querySelector('#waveNote').textContent.trim(),
  }));
  console.log('  换素材后:', JSON.stringify(after));
  ok('版本树归零（只余 origin + 新导入）', after.tree === 2, after.treeLabels.join('/'));
  ok('A/B 重新禁用', after.abDisabled === true);
  ok('精修按钮复位', after.processLabel === '执行精修', after.processLabel);
  ok('再生按钮复位', after.renderLabel === '渲染乐段', after.renderLabel);
  ok('音符轨清空', after.tracks === 0, String(after.tracks));
  ok('质检复位为待执行', after.checks.every((c) => c === '待执行'), after.checks.join('/'));
  ok('波形注释复位', after.waveNote.includes('尚未精修'), after.waveNote);

  // ---------- 3. 同一文件重复选择也应触发 ----------
  console.log('\n== 文件输入可重复触发 ==');
  const inputReset = await page.evaluate(() => {
    const i = document.querySelector('#fileInput');
    return i.value === '';
  });
  ok('change 后 input.value 已清空（可重选同一文件）', inputReset);

  // ---------- 4. 无 JS 报错 ----------
  console.log('\n== 控制台 ==');
  ok('全程无 JS 报错', errs.length === 0, errs.slice(0, 4).join(' | '));

  await browser.close();
  console.log('\n' + (fails.length ? `✗ ${fails.length} 项失败:\n  - ${fails.join('\n  - ')}` : '✓ 全部通过'));
  process.exit(fails.length ? 1 : 0);
})();
