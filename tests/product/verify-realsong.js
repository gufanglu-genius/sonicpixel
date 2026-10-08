// 任务③端到端：真歌示例 → 体检处方 → 精修 → 渲染 → 存盘 → 刷新恢复 → 导出
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const U = 'http://127.0.0.1:8080/';
const path = require('path'), fs = require('fs');
const OUT = '/tmp/sonic-shots/product/out'; fs.mkdirSync(OUT, { recursive: true });

function wavOk(b, bits) {
  return b.toString('ascii',0,4)==='RIFF' && b.toString('ascii',8,12)==='WAVE'
    && b.readUInt16LE(34)===bits && b.readUInt32LE(40)===b.length-44
    && b.readUInt32LE(40) % (b.readUInt16LE(22)*bits/8) === 0;
}
(async () => {
  const br = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const ctx = await br.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  let fail = 0; const ok = (c,n,d)=>{ if(!c)fail++; console.log(`${c?'  ✓':'  ✗'} ${n}${d?'  — '+d:''}`); };
  p.on('pageerror', e => console.log('PAGE-ERROR:', e.message));
  p.on('console', m => { if (m.type()==='error') console.log('CONSOLE:', m.text()); });

  await p.goto(U + '?fresh=1', { waitUntil: 'networkidle' });

  // 按钮文案已换成真歌
  ok((await p.textContent('#btnDemo')).includes('真歌'), '示例按钮已改成真歌', await p.textContent('#btnDemo'));
  ok((await p.textContent('#btnHeroDemo')).includes('真歌'), 'Hero 按钮已改成真歌', await p.textContent('#btnHeroDemo'));

  const t0 = Date.now();
  await p.click('#btnDemo');
  await p.waitForFunction(() => document.querySelector('#mBpm').textContent.trim() !== '—', null, { timeout: 180000 });
  console.log(`   载入+体检 ${((Date.now()-t0)/1000).toFixed(1)}s`);

  const r = await p.evaluate(() => {
    const t = s => (document.querySelector(s)?.textContent||'').trim();
    return {
      drop: t('#dropStatus'), bpm: t('#mBpm'), sr: t('#mSr'),
      srSub: (document.querySelector('#mSr')?.closest('.metric')?.querySelector('.metric-sub')?.textContent||'').trim(), mode: t('#modeName'), dur: t('#mDur'),
      cent: t('#mCent'), mud: t('#mMud'),
      rx: [...document.querySelectorAll('#prescription .prescription-item')].map(e=>e.textContent.trim().replace(/\s+/g,' ')),
      kindHint: t('#kindHint'),
      segs: [...document.querySelectorAll('#structureLegend .legend-item')].map(e=>e.textContent.trim()),
      eq: [...document.querySelectorAll('.eq-band input')].map(i=>i.value).join(','),
    };
  });
  ok(/龙城风·巷砖记/.test(r.drop), '体检用的是真歌素材', r.drop);
  ok(r.bpm !== '—' && r.mode !== '待检测', 'BPM/调式有结果', `${r.bpm} / ${r.mode} / ${r.dur}`);
  // 素材是 48k FLAC，decodeAudioData 会重采到 44.1k —— 报 44.1 就是把原生采样率说错了
  // #mSr 的 textContent 带 <span class="unit">kHz</span> 后缀，先剥掉再比
  ok(r.sr.replace(/kHz$/,'').trim() === '48.0' && r.srSub === '原始采样率',
     '采样率报的是原文件的 48k', `${r.sr} / ${r.srSub}`);
  // 分治之后多一条：前三条是共同的滤波/EQ/谐波，第四条按素材类型走
  // （AI=动态还原，录音=底噪与动态），所以这里数的是 4。
  ok(r.rx.length === 4, '开出四条处方（含素材类型专属那条）', String(r.rx.length));
  ok(r.rx.some(x=>/动态还原|底噪与动态/.test(x)), '第四条是素材类型专属处方',
     r.rx[3] ? r.rx[3].slice(0,40) : '(空)');
  // 换素材后这首没检出工频哼声，真缺陷变成「低频有量但松散」——
  // 断言必须跟着素材走，否则就是在要求一个不存在的毛病。
  ok(r.rx.some(x => /90Hz/.test(x)), '处方点出低频松散（真缺陷）', r.rx[1] || '');
  ok(/未检出工频哼声/.test(r.kindHint), '提示如实说明这首没有哼声', r.kindHint);
  ok(r.segs.length >= 3, '结构分出多段', r.segs.join(' | '));
  ok(r.eq !== '0,0,0,0,0,0,0,0,0,0', 'EQ 按处方预置非全零', r.eq);

  // 全链
  await p.click('#btnProcess');
  await p.waitForFunction(() => !document.querySelector('#btnProcess').disabled
    && !document.querySelector('#btnExportProcessed').disabled, null, { timeout: 120000 });
  ok(true, '精修完成');
  await p.click('#btnRender');
  await p.waitForFunction(() => document.querySelector('#btnRender').textContent === '重新渲染'
    && !document.querySelector('#btnRender').disabled, null, { timeout: 120000 });
  ok(true, '乐段渲染完成');

  // 导出（文件名应去掉「示例 · 」前缀）
  const [d1] = await Promise.all([p.waitForEvent('download'), p.click('#btnExportProcessed')]);
  const f1 = path.join(OUT, 'real_' + d1.suggestedFilename());
  await d1.saveAs(f1);
  const b1 = fs.readFileSync(f1);
  ok(wavOk(b1, 24), '导出精修 WAV', `${d1.suggestedFilename()} ${(b1.length/1048576).toFixed(1)}MB`);
  ok(d1.suggestedFilename() === '龙城风·巷砖记-古方路杰出青年_精修.wav', '导出名去掉「示例 · 」前缀', d1.suggestedFilename());

  const [d2] = await Promise.all([p.waitForEvent('download'), p.click('#btnExportMix')]);
  const f2 = path.join(OUT, 'real_' + d2.suggestedFilename());
  await d2.saveAs(f2);
  ok(wavOk(fs.readFileSync(f2), 24), '导出混音 WAV', `${d2.suggestedFilename()} ${(fs.statSync(f2).size/1048576).toFixed(1)}MB`);

  await p.waitForFunction(() => /已自动存盘/.test(document.querySelector('#saveStatus').textContent), null, { timeout: 60000 });
  const saved = await p.textContent('#saveStatus');
  console.log('   ', saved);

  // 刷新恢复
  await p.goto(U, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => /已恢复上次工作区/.test(document.querySelector('#dropStatus').textContent),
    null, { timeout: 180000 });
  const after = await p.evaluate(() => ({
    drop: document.querySelector('#dropStatus').textContent.trim(),
    bpm: document.querySelector('#mBpm').textContent.trim(),
    proc: !document.querySelector('#btnExportProcessed').disabled,
    procLabel: document.querySelector('#btnProcess').textContent,
    renderLabel: document.querySelector('#btnRender').textContent,
    mix: !document.querySelector('#btnExportMix').disabled,
    tree: document.querySelectorAll('#tree .tree-node').length,
    tracks: document.querySelectorAll('#tracks .track').length,
    segs: [...document.querySelectorAll('#structureLegend .legend-item')].map(e=>e.textContent.trim()),
  }));
  ok(/龙城风·巷砖记/.test(after.drop), '真歌工作区已恢复', after.drop);
  ok(after.bpm === r.bpm && after.segs.join() === r.segs.join(), '体检结果与恢复前一致', after.bpm);
  ok(after.proc && after.procLabel === '重新精修', '精修产物与按钮状态恢复');
  ok(after.renderLabel === '重新渲染' && after.tracks === 5, '编曲与五轨恢复', `${after.renderLabel} / ${after.tracks}轨`);
  ok(after.tree >= 4, '版本树恢复', String(after.tree));

  const [d3] = await Promise.all([p.waitForEvent('download'), p.click('#btnExportProcessed')]);
  ok(d3.suggestedFilename() === '龙城风·巷砖记-古方路杰出青年_精修.wav', '恢复后仍可直接导出', d3.suggestedFilename());

  // 素材缺失时的兜底：把 URL 指到不存在的路径
  console.log('── 素材缺失兜底 ──');
  const p2 = await ctx.newPage();
  p2.on('pageerror', e => console.log('PAGE-ERROR2:', e.message));
  await p2.route('**/assets/ai-song-demo.flac', r => r.fulfill({ status: 404, body: '' }));
  await p2.goto(U + '?fresh=1&synth=1', { waitUntil: 'networkidle' });
  await p2.evaluate(() => { history.replaceState({}, '', location.pathname); }); // 去掉 synth，走真歌分支
  await p2.click('#btnDemo');
  await p2.waitForFunction(() => document.querySelector('#mBpm').textContent.trim() !== '—', null, { timeout: 60000 });
  const fb = await p2.evaluate(() => document.querySelector('#dropStatus').textContent.trim());
  // 上面已去掉 synth，但 route 拦了 fetch → 应退回合成曲
  ok(/五声调式合成/.test(fb), '素材 404 时退回合成示例', fb);
  await p2.close();

  console.log('\n' + '═'.repeat(60));
  console.log(fail ? `失败 ${fail} 项` : '真歌示例全绿');
  await br.close(); process.exit(fail?1:0);
})().catch(e => { console.error('FAIL:', e.stack||e.message); process.exit(1); });
