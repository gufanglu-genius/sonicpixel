const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const FILE = process.argv[2] || '/Users/chenhuidediannao/Desktop/红头绳.wav';
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', e => console.log('P:', e.message));
  await p.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle' });

  const t0 = Date.now();
  await p.setInputFiles('#fileInput', FILE);
  await p.waitForFunction(() => document.querySelector('#mBpm')?.textContent.trim() !== '—', { timeout: 120000 });
  console.log('① 解码+体检:', ((Date.now()-t0)/1000).toFixed(2), 's');

  const r = await p.evaluate(async () => {
    const E = window.SonicEngine;
    const out = {};
    // 直接拿页面已有的 origin buffer 重跑一遍 —— 但 state 是闭包，
    // 改从 AudioContext 重新解码原始文件不现实；改测「同尺寸输入」的处理成本
    const SR = 44100, SEC = 153; // 红头绳约 153s
    const ctx = new OfflineAudioContext(2, SR*SEC, SR);
    const buf = ctx.createBuffer(2, SR*SEC, SR);
    for (let c=0;c<2;c++){ const d=buf.getChannelData(c); for(let i=0;i<d.length;i+=3) d[i]=Math.sin(i*0.01)*0.4; }
    const params = { highpass:30, eq:new Array(10).fill(0), exciter:0.3, denoise:0.25, threshold:0.35, ratio:0.32, intensity:0.55 };
    let t = performance.now();
    await E.process(buf, params);
    out.processMs = Math.round(performance.now()-t);
    t = performance.now();
    const res = await E.renderArrangement({ rootMidi:60, modeIndex:0, bpm:91.4, bars:8, muted:{}, meter:'4/4' });
    out.renderMs = Math.round(performance.now()-t);
    t = performance.now();
    const wav = E.bufferToWav(buf, 16);
    out.wav16Ms = Math.round(performance.now()-t);
    out.originWavMb = +(wav.size/1048576).toFixed(1);
    // 同尺寸 processed 的 WAV16
    t = performance.now();
    const arr = await E.renderArrangement({ rootMidi:60, modeIndex:0, bpm:91.4, bars:8, muted:{}, meter:'4/4' });
    out.arrWavMb = +(E.bufferToWav(arr.buffer,16).size/1048576).toFixed(1);
    return out;
  });
  console.log('② process() 重算:', r.processMs, 'ms');
  console.log('③ renderArrangement:', r.renderMs, 'ms  乐段WAV16:', r.arrWavMb, 'MB');
  console.log('④ 同尺寸 WAV16 编码:', r.wav16Ms, 'ms  大小:', r.originWavMb, 'MB');
  await b.close();
})();
