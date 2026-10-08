const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const FILE = '/Users/chenhuidediannao/Desktop/红头绳.wav';
const path = require('path'); const fs = require('fs');
const OUT = '/tmp/sonic-shots/product/out';
fs.mkdirSync(OUT, { recursive: true });

function checkWav(p, wantBits) {
  const b = fs.readFileSync(p);
  // WAV 头偏移：20=格式码 22=声道 24=采样率 28=字节率 32=块对齐 34=位深 40=data长度
  const ch = b.readUInt16LE(22), sr = b.readUInt32LE(24);
  const bits = b.readUInt16LE(34), data = b.readUInt32LE(40);
  const actual = b.length - 44, stride = ch * bits / 8;
  return { sig: b.toString('ascii', 0, 4), bits, data, ch, actual, stride,
    ok: b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE'
      && bits === wantBits && data === actual && data % stride === 0
      && b.readUInt32LE(28) === sr * b.readUInt16LE(32) };
}

(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('P:', e.message));
  p.on('console', m => { if (m.type() === 'error') console.log('C:', m.text()); });
  await p.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle' });

  await p.setInputFiles('#fileInput', FILE);
  await p.waitForFunction(() => document.querySelector('#mBpm')?.textContent.trim() !== '—', { timeout: 120000 });
  console.log('体检完成');

  // ── L2 精修导出 ──
  await p.click('#btnProcess');
  await p.waitForFunction(() => !document.querySelector('#btnExportProcessed').disabled, { timeout: 60000 });
  console.log('精修完成，导出按钮已启用:', await p.textContent('#btnExportProcessed'));

  const [d1] = await Promise.all([p.waitForEvent('download'), p.click('#btnExportProcessed')]);
  const f1 = path.join(OUT, d1.suggestedFilename());
  await d1.saveAs(f1);
  const c1 = checkWav(f1, 24);
  console.log(`① 导出精修 → "${d1.suggestedFilename()}"  ${c1.ok ? 'PASS' : 'FAIL'}  bits=${c1.bits} data=${c1.data}/${c1.expectData} ch=${c1.ch} 实际=${c1.actual}B`);

  // ── L3 混音导出 ──
  await p.click('#btnRender');
  // #btnExportMix 从来没有 disabled 属性，拿它当条件等于立刻通过；
  // 真正的完成信号是 #btnRender 复位成「重新渲染」（finally 在 flushSave 之后）
  await p.waitForFunction(
    () => document.querySelector('#btnRender').textContent === '重新渲染'
       && !document.querySelector('#btnRender').disabled,
    { timeout: 60000 });
  const [d2] = await Promise.all([p.waitForEvent('download'), p.click('#btnExportMix')]);
  const f2 = path.join(OUT, d2.suggestedFilename());
  await d2.saveAs(f2);
  const c2 = checkWav(f2, 24);
  console.log(`② 导出混音 → "${d2.suggestedFilename()}"  ${c2.ok ? 'PASS' : 'FAIL'}  bits=${c2.bits} data=${c2.data}/${c2.expectData} ch=${c2.ch} 实际=${c2.actual}B`);

  console.log('状态条:', (await p.textContent('#heroStatusText')) || (await p.textContent('#dropStatus')));

  // 分轨现在是单个 zip（store 模式，含 mid + manifest），24 位
  // 结构与 CRC 由 /tmp/sonic-shots/midi/e2e.js 那条单独验
  const [d3] = await Promise.all([p.waitForEvent('download'), p.click('#btnExportStems')]);
  console.log('③ 分轨导出（24位单 zip，回归检查）→', d3.suggestedFilename());
  await b.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
