/* 评委路径：打开页面 → 点示例音频 → 五站走完 → 逐步截图 */
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const OUT = '/tmp/sonic-shots/product';
let pass=0, fail=0;
const ok=(c,n,d)=>{c?(pass++,console.log(`  ✓ ${n}  — ${d}`)):(fail++,console.log(`  ✗ ${n}  — ${d}`));};
const sleep = ms => new Promise(r=>setTimeout(r,ms));

(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox','--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs=[]; p.on('pageerror',e=>errs.push('P:'+e.message));
  p.on('console',m=>{ if(m.type()==='error') errs.push('C:'+m.text()); });

  await p.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle' });
  await sleep(800);
  await p.screenshot({ path: `${OUT}/smoke-01-hero.png` });

  await p.click('#btnHeroDemo');
  const analyzed = await p.waitForFunction(() => {
    const m = document.querySelector('#mBpm');
    return m && m.textContent.trim() !== '—';
  }, { timeout: 120000 }).then(()=>true).catch(()=>false);
  await sleep(1500);
  const l1 = await p.evaluate(() => ({
    bpm: document.querySelector('#mBpm')?.textContent.trim(),
    meter: document.querySelector('#mMeter')?.textContent.trim(),
    bpmRange: document.querySelector('#bpmRange')?.value,
    bpmOut: document.querySelector('#bpmOut')?.textContent.trim(),
    chips: [...document.querySelectorAll('#modeChips .chip')].map(c=>c.textContent.replace(/\s+/g,'')).join(' '),
    status: document.querySelector('#heroStatusText')?.textContent.trim(),
  }));
  ok(analyzed, '示例音频体检完成', JSON.stringify(l1.status));
  ok(l1.bpmRange === String(parseFloat(l1.bpm)), '示例也接上速度链', `L1 ${l1.bpm} → 滑块 ${l1.bpmRange}`);
  await p.evaluate(()=>document.querySelector('#sec-check').scrollIntoView({block:'start'}));
  await sleep(500); await p.screenshot({ path: `${OUT}/smoke-02-check.png` });

  await p.click('#btnProcess');
  await p.waitForFunction(()=>{const x=document.querySelector('#btnProcess');return x&&!x.disabled&&/完成|重新|执行/.test(x.textContent);},{timeout:180000}).catch(()=>{});
  await sleep(700);
  await p.evaluate(()=>document.querySelector('#sec-refine').scrollIntoView({block:'start'}));
  await p.screenshot({ path: `${OUT}/smoke-03-refine.png` });

  await p.evaluate(()=>document.querySelector('#sec-create').scrollIntoView({block:'start'}));
  await sleep(300);
  await p.click('#btnRender');
  await p.waitForFunction(()=>{const x=document.querySelector('#btnRender');return x&&(x.textContent.includes('重新渲染')||x.textContent.includes('失败'));},{timeout:120000});
  await sleep(700);
  const l3 = await p.evaluate(()=>({
    badge: document.querySelector('#meterOut')?.textContent.trim(),
    title: document.querySelector('#meterOut')?.title,
    hint: document.querySelector('#meterHint')?.textContent.trim(),
    bpmOut: document.querySelector('#bpmOut')?.textContent.trim(),
  }));
  await p.screenshot({ path: `${OUT}/smoke-04-create.png` });

  await p.evaluate(()=>document.querySelector('#sec-deliver').scrollIntoView({block:'start'}));
  await p.click('#btnRecheck');
  await p.waitForFunction(()=>{const v=[...document.querySelectorAll('#checks .check-value')];return v.length&&v.every(x=>x.textContent.trim()!=='待执行');},{timeout:120000}).catch(()=>{});
  await sleep(800);
  const checks = await p.evaluate(()=>[...document.querySelectorAll('#checks .check')].map(c=>({
    n:c.querySelector('.check-name')?.textContent.trim(),
    v:c.querySelector('.check-value')?.textContent.trim(),
    note:c.querySelector('p:last-of-type')?.textContent.trim(),
    cls:c.className.replace('check ','').trim(),
  })));
  await p.screenshot({ path: `${OUT}/smoke-05-deliver.png` });
  await p.screenshot({ path: `${OUT}/smoke-06-full.png`, fullPage: true });

  console.log('L3 徽章:', JSON.stringify(l3));
  checks.forEach(c=>console.log(`   ${c.cls} | ${c.n}: ${c.v} | ${c.note}`));
  ok(checks.every(c=>c.cls==='is-ok'), '回流三项全过', `${checks.filter(c=>c.cls==='is-ok').length}/3`);
  ok(checks.every(c=>!/退化|压得过平/.test(c.note||'')), '无「退化」假指控', checks.map(c=>c.cls).join(','));
  ok(errs.length===0, '全程无 JS 报错', errs.length?errs.slice(0,5).join(' | '):'clean');

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  await b.close();
  process.exit(fail?1:0);
})();
