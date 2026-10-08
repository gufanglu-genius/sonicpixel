const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const FILE = process.argv[2] || '/Users/chenhuidediannao/Desktop/红头绳.wav';
(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', e => console.log('P:', e.message));
  await p.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle' });

  await p.setInputFiles('#fileInput', FILE);
  await p.waitForFunction(() => document.querySelector('#mBpm')?.textContent.trim() !== '—', { timeout: 180000 });
  const meta = await p.evaluate(() => ({ dur: document.querySelector('#mDur')?.textContent, sr: document.querySelector('#mSr')?.textContent }));
  console.log('素材:', JSON.stringify(meta));

  // process() 耗时
  let t = Date.now();
  await p.click('#btnProcess');
  await p.waitForFunction(() => { const x=document.querySelector('#btnProcess'); return x && !x.disabled && /完成|重新/.test(x.textContent); }, { timeout: 300000 });
  console.log('process 耗时:', ((Date.now()-t)/1000).toFixed(2), 's');

  // 渲染乐段耗时
  t = Date.now();
  await p.click('#btnRender');
  await p.waitForFunction(() => { const x=document.querySelector('#btnRender'); return x && /重新渲染|失败/.test(x.textContent); }, { timeout: 180000 });
  console.log('renderArrangement 耗时:', ((Date.now()-t)/1000).toFixed(2), 's');

  // IndexedDB 写/读 三个 AudioBuffer 的裸 PCM 耗时与体积
  const r = await p.evaluate(async () => {
    const st = window.__st;
    // 拿不到内部 state，直接用页面里的 audio 上下文另造：测 IDB 吞吐
    const SR = 44100, SEC = 240, N = SR*SEC;
    const mk = () => { const a = new Float32Array(N), c = new Float32Array(N); for(let i=0;i<N;i+=11){a[i]=Math.sin(i*0.01);c[i]=Math.sin(i*0.013);} return [a,c]; };
    const bufs = [mk(), mk(), mk()]; // origin + processed + arrangement 近似
    const bytes = bufs.flat().reduce((s,x)=>s+x.byteLength,0);
    const t0 = performance.now();
    const db = await new Promise((res,rej)=>{ const q=indexedDB.open('measure',1); q.onupgradeneeded=()=>q.result.createObjectStore('s'); q.onsuccess=()=>res(q.result); q.onerror=()=>rej(q.error); });
    await new Promise((res,rej)=>{ const tx=db.transaction('s','readwrite'); tx.objectStore('s').put({ bufs, tag:'x' }, 'k'); tx.oncomplete=res; tx.onerror=()=>rej(tx.error); });
    const t1 = performance.now();
    const back = await new Promise((res,rej)=>{ const tx=db.transaction('s','readonly'); const q=tx.objectStore('s').get('k'); q.onsuccess=()=>res(q.result); q.onerror=()=>rej(q.error); });
    const t2 = performance.now();
    return { mb: (bytes/1024/1024).toFixed(1), writeMs: Math.round(t1-t0), readMs: Math.round(t2-t1), got: back.bufs.length };
  });
  console.log('IDB 三轨裸PCM:', JSON.stringify(r));
  await b.close();
})();
