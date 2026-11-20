/* 乐队编配接入验收（AI乐队内核 → 音智新媒 L3）
   断言口径：
   1. 默认路：渲染后 arrangement.engine === 'band'，事件非空、时长与
      bars×4×60/bpm 对得上（0.01s 内）、buffer 非静音、指挥按钮亮起；
   2. BAND_CONFIG 已接上「接口设置」（千问兼容端点 + 模型名）；
   3. 对话指挥走离线规则（临时清 key 钉死离线，测完还原）：
      「鼓密一点」只动鼓的疏密，其余轨与 engine 标记不动；
   4. ?engine=1 强制回引擎路，engine === 'engine'。
   素材走 ?synth=1 合成示例（红头绳.wav 已不在本机，真歌套件环境性
   不可跑是既有事实）；要打真歌传 argv[2] 覆盖。
   数字全部来自页面实测，不写估算。 */
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const FILE = process.argv[2] || null;   // null → ?synth=1 + #btnDemo
const U = 'http://127.0.0.1:8080/';

(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrs = [];
  const conErrs = [];
  p.on('pageerror', (e) => pageErrs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') conErrs.push(m.text()); });

  let pass = 0, fail = 0;
  const ok = (c, n, d) => {
    if (c) { pass++; console.log(`  ✓ ${n}${d ? '  — ' + d : ''}`); }
    else { fail++; console.log(`  ✗ ${n}${d ? '  — ' + d : ''}`); }
  };

  // 素材装载：给了文件走导入，没给走合成示例（两条都等体检出数）
  const loadMaterial = async (page, query) => {
    if (FILE) {
      await page.goto(U + (query || ''), { waitUntil: 'networkidle' });
      await page.setInputFiles('#fileInput', FILE);
    } else {
      await page.goto(`${U}?fresh=1&synth=1${query ? '&' + query.replace(/^\?/, '') : ''}`,
        { waitUntil: 'networkidle' });
      await page.click('#btnDemo');
    }
    await page.waitForFunction(() => document.querySelector('#mBpm')?.textContent.trim() !== '—',
      null, { timeout: 120000 });
  };

  console.log('══ 乐队编配接入 ══');
  await loadMaterial(p);
  await p.waitForTimeout(800);

  // ---- 1. 默认路：band ----
  await p.click('#btnRender');
  await p.waitForFunction(() => {
    const x = document.querySelector('#btnRender');
    return x && (x.textContent.includes('重新渲染') || x.textContent.includes('失败'));
  }, null, { timeout: 120000 });
  await p.waitForTimeout(500);

  const r1 = await p.evaluate(() => {
    const a = window.__state.arrangement;
    if (!a) return { none: true };
    const buf = a.buffer;
    let peak = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i += 53) {
        const v = Math.abs(d[i]);
        if (v > peak) peak = v;
      }
    }
    const bpm = Number(document.querySelector('#bpmRange').value);
    const bars = Number(document.querySelector('#barsRange').value);
    return {
      engine: a.engine,
      events: a.events.length,
      duration: a.duration,
      peak: +peak.toFixed(4),
      bpm, bars,
      expectSec: (bars * 4 * 60) / bpm,
      stale: a.stale,
      tracks: (a.tracks || []).map((t) => t.id).join(','),
      bandModel: !!window.__state.bandModel,
      modelBars: window.__state.bandModel && window.__state.bandModel.bars,
      modelBpm: window.__state.bandModel && window.__state.bandModel.bpm,
      btnChat: !document.querySelector('#btnBandChat').disabled,
      chatState: document.querySelector('#bandChatState').textContent.trim(),
      sampler: (window.BandSampler && window.BandSampler.status && window.BandSampler.status()) || 'absent',
      cfg: window.BAND_CONFIG ? {
        endpoint: window.BAND_CONFIG.llmEndpoint || '',
        model: window.BAND_CONFIG.llmModel || '',
        hasKey: !!window.BAND_CONFIG.llmApiKey,
      } : null,
    };
  });
  console.log('   ', JSON.stringify(r1));
  ok(r1.engine === 'band', '默认路走乐队内核', `engine=${r1.engine}`);
  ok(r1.events > 0, '事件非空', `${r1.events} 个`);
  ok(Math.abs(r1.duration - r1.expectSec) < 0.01, '时长与 bars/BPM 对账',
    `实测 ${r1.duration.toFixed(3)}s vs 目标 ${r1.expectSec.toFixed(3)}s`);
  ok(r1.peak > 0.01, 'buffer 非静音', `peak=${r1.peak}`);
  ok(r1.stale === false, '渲染后不带 stale');
  ok(r1.tracks === 'lead,harm,bass,drums,pad', '五轨齐全', r1.tracks);
  ok(r1.bandModel && r1.modelBars === r1.bars, 'bandModel 已落', `bars=${r1.modelBars}`);
  ok(r1.modelBpm === r1.bpm, '模型速度与滑块一致', `model=${r1.modelBpm} 滑块=${r1.bpm}`);
  ok(r1.btnChat === true, '指挥按钮已亮', r1.chatState);
  ok(r1.sampler === 'ready', '采样音源就绪', `status=${r1.sampler}`);
  ok(!!r1.cfg && /\/chat\/completions$/.test(r1.cfg.endpoint) && !!r1.cfg.model,
    'BAND_CONFIG 接上千问兼容端点',
    r1.cfg ? `${r1.cfg.model} @ ${r1.cfg.endpoint}` : '缺失');

  // ---- 2. 对话指挥（钉死离线，测完还原 key） ----
  const r2 = await p.evaluate(async () => {
    const saved = window.BAND_CONFIG.llmApiKey;
    window.BAND_CONFIG.llmApiKey = '';           // 离线规则，不打真接口
    const before = JSON.stringify({
      density: window.__state.bandModel.density,
      muted: window.__state.bandModel.muted,
    });
    const inp = document.querySelector('#bandChatInput');
    inp.value = '鼓密一点';
    document.querySelector('#btnBandChat').click();
    // 等两泡齐全（用户 + 回复）且 busy 归位；只看 busy 会在异步起步前空转退出
    const t0 = performance.now();
    while (performance.now() - t0 < 30000) {
      const n = document.querySelectorAll('#bandChatLog .ai-bubble').length;
      if (n >= 2 && !window.__state.bandChatBusy) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const m = window.__state.bandModel;
    const a = window.__state.arrangement;
    const log = [...document.querySelectorAll('#bandChatLog .ai-bubble')].map((x) => x.textContent.trim());
    const after = JSON.stringify({
      density: m.density,
      muted: m.muted,
    });
    window.BAND_CONFIG.llmApiKey = saved;        // 还原
    return {
      busy: window.__state.bandChatBusy,
      before, after,
      drumsDensity: m.density && m.density.drums,
      engine: a.engine,
      stale: a.stale,
      events: a.events.length,
      reply: log[log.length - 1] || '',
      userSaid: log[0] || '',
      btnChat: !document.querySelector('#btnBandChat').disabled,
    };
  });
  console.log('   ', JSON.stringify(r2));
  ok(r2.busy === false, '指挥收尾（busy 归位）');
  ok(r2.userSaid === '鼓密一点', '用户指令入泡', r2.userSaid);
  ok(/收到|疏密/.test(r2.reply), '离线回复在泡里', r2.reply);
  ok(r2.drumsDensity > 0.5, '鼓疏密被调高', `drums=${r2.drumsDensity}`);
  ok(r2.before !== r2.after, '模型确实被补丁改写');
  ok(r2.engine === 'band' && r2.stale === false && r2.events > 0,
    '指挥后仍是乐队路且产物有效',
    `engine=${r2.engine} events=${r2.events} stale=${r2.stale}`);
  ok(r2.btnChat === true, '指挥按钮复位可用');

  // ---- 3. ?engine=1 强制回引擎 ----
  const p2 = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p2.on('pageerror', (e) => pageErrs.push('engine=1: ' + e.message));
  await loadMaterial(p2, '?engine=1');
  await p2.click('#btnRender');
  await p2.waitForFunction(() => {
    const x = document.querySelector('#btnRender');
    return x && (x.textContent.includes('重新渲染') || x.textContent.includes('失败'));
  }, null, { timeout: 120000 });
  const r3 = await p2.evaluate(() => ({
    engine: window.__state.arrangement && window.__state.arrangement.engine,
    bandModel: !!window.__state.bandModel,
    btnChat: !document.querySelector('#btnBandChat').disabled,
    chatState: document.querySelector('#bandChatState').textContent.trim(),
  }));
  console.log('   ', JSON.stringify(r3));
  ok(r3.engine === 'engine', '?engine=1 强制引擎路', `engine=${r3.engine}`);
  ok(r3.bandModel === false, '引擎路不落 bandModel');
  ok(r3.btnChat === false, '引擎路指挥禁用', r3.chatState);
  await p2.close();

  console.log(`\n${pass} 通过 / ${fail} 失败 · pageerror ${pageErrs.length} · console.error ${conErrs.length}`);
  pageErrs.slice(0, 5).forEach((e) => console.log('  P!', e));
  conErrs.slice(0, 5).forEach((e) => console.log('  C!', e));
  await b.close();
  process.exit(fail || pageErrs.length || conErrs.length ? 1 : 0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
