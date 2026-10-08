/* 原曲五线谱验收：卡片结构、谱面模型、画布非空、诚实声明、
   PNG 导出、MusicXML 导出（结构/配平/解析）、证据链页签不被挤掉
  （仍是 5 个）、窗口重绘。用法：node tests/product/verify-score.js */
const fs = require('fs');
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

  await p.goto('http://127.0.0.1:8080/?fresh=1&synth=1', { waitUntil: 'networkidle' });

  // ① 结构：卡片在证据链卡片之后、不在 evTabs 里
  const dom = await p.evaluate(() => ({
    card: !!document.getElementById('scoreCard'),
    canvas: !!document.getElementById('chartScore'),
    btn: !!document.getElementById('btnScorePng'),
    note: document.getElementById('scoreNote')?.textContent.trim() || '',
    chips: document.querySelectorAll('#evTabs .chip').length,
    cardAfterEvidence: (() => {
      const ev = document.getElementById('evidenceCard');
      const sc = document.getElementById('scoreCard');
      return !!(ev && sc && ev.compareDocumentPosition(sc) & Node.DOCUMENT_POSITION_FOLLOWING);
    })(),
  }));
  console.log('① 结构');
  ok(dom.card, 'scoreCard 存在');
  ok(dom.canvas && dom.btn, 'canvas + 导出按钮存在');
  ok(dom.cardAfterEvidence, '卡片排在证据链之后（没有动 evTabs）');
  // 空态页签还没建（buildEvidenceUI 体检后才跑），只要不是第 6 个
  ok(dom.chips === 0 || dom.chips === 5, '空态无页签 / 至多 5 个', dom.chips);

  // ② buildScore 纯函数口径：拍号兜底 / 相邻同音合并 / 小节数
  console.log('② buildScore 模型');
  const unit = await p.evaluate(() => {
    const E = window.SonicEngine;
    // 93ms 帧、C4 持续 10 帧 → 约 2.4 个 16 分（92BPM 下）
    const ev = (midi, frames) => ({ k: 'n', midi, frames });
    const s1 = E.buildScore([ev(60, 10), ev(60, 8)], { bpm: 92.1, meter: null, sampleRate: 44100 });
    const s2 = E.buildScore([{ k: 'r', frames: 40 }, ev(64, 6)], { bpm: 120, meter: '6/8', sampleRate: 44100 });
    return {
      fallbackMeter: s1.meter, fallbackGrid: s1.gridPerBar, bars1: s1.bars,
      merged: s1.items.length === 1 && s1.items[0].dur > 4,
      m68: s2.meter === '6/8' && s2.gridPerBar === 12,
      leadRest: s2.items[0] && s2.items[0].k === 'r' && s2.items[0].dur > 0,
      noteCount: s1.noteCount,
    };
  });
  ok(unit.fallbackMeter === '4/4' && unit.fallbackGrid === 16, '拍号缺失按 4/4 兜底', unit);
  ok(unit.bars1 >= 1, '小节数 ≥ 1', unit.bars1);
  ok(unit.merged, '相邻同音合并且时值相加', unit);
  ok(unit.m68, '6/8 → gridPerBar 12', unit);
  ok(unit.leadRest, '休止作为 item 保留', unit);
  ok(unit.noteCount === 1, 'noteCount 只数音符', unit.noteCount);

  // ③ demo 体检 → 谱面
  await p.click('#btnDemo');
  await p.waitForFunction(() =>
    document.querySelectorAll('#evTabs .chip').length === 5 &&
    window.__state.score && window.__state.score.noteCount > 0
  , null, { timeout: 90000 });
  console.log('③ demo 谱面');
  const scored = await p.evaluate(() => {
    const s = window.__state.score;
    const cv = document.getElementById('chartScore');
    const g = cv.getContext('2d');
    const img = g.getImageData(0, 0, cv.width, cv.height).data;
    // 只数「墨色」像素（r+g+b < 500）：纸底铺满后全画布 alpha 都是 255，
    // 按 alpha 数会把纸底也当成墨迹
    let ink = 0;
    for (let i = 0; i < img.length; i += 4) {
      if (img[i + 3] > 16 && img[i] + img[i + 1] + img[i + 2] < 500) ink++;
    }
    const corner = g.getImageData(1, 1, 1, 1).data;   // 导出 PNG 的背景是否镂空
    return {
      bars: s.bars, noteCount: s.noteCount, items: s.items.length,
      units: s.units, grid: s.gridPerBar,
      ink, cw: cv.width, ch: cv.height,
      bgOpaque: corner[3] === 255,
      key: document.getElementById('scoreKeyTag').textContent.trim(),
      meter: document.getElementById('scoreMeterTag').textContent.trim(),
      bpm: document.getElementById('scoreBpmTag').textContent.trim(),
      note: document.getElementById('scoreNote').textContent.trim(),
      btnEnabled: !document.getElementById('btnScorePng').disabled,
      chips: document.querySelectorAll('#evTabs .chip').length,
    };
  });
  ok(scored.bars >= 1 && scored.noteCount > 0 && scored.items > 0, '谱面模型有内容', scored);
  ok(scored.units === scored.bars * scored.grid, 'units = bars × gridPerBar', scored);
  ok(scored.ink > 5000, '画布非空（墨迹像素）', scored.ink);
  ok(scored.bgOpaque, '纸底不透明（PNG 导出不镂空）', scored.bgOpaque);
  ok(scored.key !== '—' && scored.bpm.includes('BPM'), '标签带调性与速度', { key: scored.key, bpm: scored.bpm });
  ok(/基于主导音高轨迹记谱/.test(scored.note), '诚实声明在位', scored.note);
  ok(scored.btnEnabled, '导出按钮已启用');
  ok(scored.chips === 5, '页签数仍为 5', scored.chips);

  // ④ PNG 导出
  console.log('④ PNG 导出');
  const dl = p.waitForEvent('download', { timeout: 10000 }).catch(() => null);
  await p.click('#btnScorePng');
  const d = await dl;
  ok(!!d, '触发下载');
  if (d) ok(/五线谱\.png$/.test(d.suggestedFilename()), '文件名带「五线谱.png」', d.suggestedFilename());

  // ⑤ 窗口 resize → 重绘仍非空
  console.log('⑤ resize 重绘');
  await p.setViewportSize({ width: 900, height: 900 });
  await p.waitForTimeout(500); // debounce 180ms + 绘制
  const after = await p.evaluate(() => {
    const cv = document.getElementById('chartScore');
    const g = cv.getContext('2d');
    const img = g.getImageData(0, 0, cv.width, cv.height).data;
    let ink = 0;
    for (let i = 0; i < img.length; i += 4) {
      if (img[i + 3] > 16 && img[i] + img[i + 1] + img[i + 2] < 500) ink++;
    }
    return { ink, cw: cv.width };
  });
  ok(after.ink > 3000, 'resize 后谱面重绘非空', after);

  // ⑥ MusicXML 导出：结构、时值配平、与谱面模型对账
  console.log('⑥ MusicXML 导出');
  const xmlBtn = await p.evaluate(() => {
    const b = document.getElementById('btnScoreXml');
    return !!b && !b.disabled;
  });
  ok(xmlBtn, 'MusicXML 按钮在位且可用');
  const dlX = p.waitForEvent('download', { timeout: 10000 }).catch(() => null);
  await p.click('#btnScoreXml');
  const dX = await dlX;
  ok(!!dX && /\.musicxml$/.test(dX.suggestedFilename()),
    '触发 .musicxml 下载', dX && dX.suggestedFilename());
  if (dX) {
    await dX.saveAs('/tmp/verify-score-export.musicxml');
    const xmlText = fs.readFileSync('/tmp/verify-score-export.musicxml', 'utf8');
    const parsed = await p.evaluate((text) => {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      const err = doc.querySelector('parsererror');
      const measures = doc.querySelectorAll('measure');
      const m1 = measures[0];
      const m1dur = m1
        ? [...m1.querySelectorAll('note')]
            .reduce((s, n) => s + Number(n.querySelector('duration').textContent), 0)
        : -1;
      const sounding = [...doc.querySelectorAll('note')]
        .filter((n) => !n.querySelector('rest')).length;
      const fifths = doc.querySelector('fifths');
      const beats = doc.querySelector('beats');
      const tempo = doc.querySelector('sound');
      const div = doc.querySelector('divisions');
      return {
        ok: !err,
        measures: measures.length,
        m1dur,
        sounding,
        fifths: fifths ? fifths.textContent : null,
        beats: beats ? beats.textContent : null,
        tempo: tempo ? tempo.getAttribute('tempo') : null,
        divisions: div ? div.textContent : null,
      };
    }, xmlText);
    ok(parsed.ok, 'XML 能被 DOMParser 解析', parsed.ok);
    ok(parsed.measures === scored.bars, '小节数 = score.bars', parsed.measures);
    ok(parsed.m1dur === scored.grid, '第 1 小节时值配平 gridPerBar', parsed.m1dur);
    ok(parsed.sounding >= scored.noteCount, '音符数 ≥ noteCount（跨小节拆件计连音线）',
      { sounding: parsed.sounding, noteCount: scored.noteCount });
    ok(parsed.divisions === '4', 'divisions = 4（单位 1/16 拍）', parsed.divisions);
    ok(parsed.fifths === '0' && parsed.beats === '4', 'C 大调 fifths=0 / 4/4',
      { fifths: parsed.fifths, beats: parsed.beats });
    const tNum = parseFloat(scored.bpm);
    ok(parsed.tempo != null && Math.abs(Number(parsed.tempo) - tNum) < 0.05,
      'tempo 与实测 BPM 一致', { tempo: parsed.tempo, bpm: scored.bpm });
  }

  // ⑦ 卡片收起/展开：主体折叠、按钮与 aria 同步、展开后按可视宽度重绘
  console.log('⑦ 收起/展开');
  await p.click('#btnScoreFold');
  const folded = await p.evaluate(() => ({
    cls: document.getElementById('scoreCard').classList.contains('folded'),
    bodyHidden: getComputedStyle(document.getElementById('scoreBody')).display === 'none',
    label: document.getElementById('btnScoreFold').textContent.trim(),
    aria: document.getElementById('btnScoreFold').getAttribute('aria-expanded'),
    stored: localStorage.getItem('sonic.scoreFolded'),
    // 标题与导出行留着：折叠只动谱面主体
    btnsVisible: getComputedStyle(document.getElementById('btnScorePng')).display !== 'none',
  }));
  ok(folded.cls && folded.bodyHidden, '点收起 → 谱面主体隐藏', folded);
  ok(folded.label === '展开' && folded.aria === 'false', '按钮文案与 aria 同步', folded);
  ok(folded.stored === '1', '选择已记进 localStorage', folded.stored);
  ok(folded.btnsVisible, '导出行保留（仍可操作）');

  await p.click('#btnScoreFold');
  const unfolded = await p.evaluate(() => {
    const cv = document.getElementById('chartScore');
    const g = cv.getContext('2d');
    const img = g.getImageData(0, 0, cv.width, cv.height).data;
    let ink = 0;
    for (let i = 0; i < img.length; i += 4) {
      if (img[i + 3] > 16 && img[i] + img[i + 1] + img[i + 2] < 500) ink++;
    }
    return {
      cls: document.getElementById('scoreCard').classList.contains('folded'),
      label: document.getElementById('btnScoreFold').textContent.trim(),
      stored: localStorage.getItem('sonic.scoreFolded'),
      ink, cssW: cv.style.width,
    };
  });
  ok(!unfolded.cls && unfolded.label === '收起', '再点 → 恢复展开');
  ok(unfolded.stored === '0', '展开状态已持久化', unfolded.stored);
  ok(unfolded.ink > 3000, '展开后按可视宽度重绘非空', unfolded);

  ok(errs.length === 0, '无页面错误', errs.slice(0, 3));
  await b.close();
  console.log(`\nverify-score: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
