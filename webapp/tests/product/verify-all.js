const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC = '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const FILE = process.argv[2] || '/Users/chenhuidediannao/Desktop/红头绳.wav';
let pass = 0, fail = 0;
const ok = (c, n, d) => { c ? (pass++, console.log(`  ✓ ${n}  — ${d}`)) : (fail++, console.log(`  ✗ ${n}  — ${d}`)); };

(async () => {
  const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push('P:'+e.message));
  p.on('console', m => { if (m.type()==='error') errs.push('C:'+m.text()); });

  await p.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle' });
  const read = () => p.evaluate(() => ({
    mBpm: document.querySelector('#mBpm')?.textContent.trim(),
    badge: document.querySelector('#meterOut')?.textContent.trim(),
    badgeTitle: document.querySelector('#meterOut')?.title,
    hint: document.querySelector('#meterHint')?.textContent.trim(),
    bpmRange: document.querySelector('#bpmRange')?.value,
    bpmOut: document.querySelector('#bpmOut')?.textContent.trim(),
  }));
  const checks = () => p.evaluate(() => [...document.querySelectorAll('#checks .check')].map(c => ({
    n: c.querySelector('.check-name')?.textContent.trim(),
    v: c.querySelector('.check-value')?.textContent.trim(),
    note: c.querySelector('p:last-of-type')?.textContent.trim(),
    cls: c.className.replace('check ','').trim(),
  })));

  await p.setInputFiles('#fileInput', FILE);
  await p.waitForFunction(() => document.querySelector('#mBpm')?.textContent.trim() !== '—', { timeout: 120000 });
  await p.waitForTimeout(1500);
  const l1 = await read();
  console.log('══ ① 体检后 ══', JSON.stringify(l1));
  ok(l1.bpmRange === String(parseFloat(l1.mBpm)), 'A1 速度滑块接上体检', `L1 ${l1.mBpm} → 滑块 ${l1.bpmRange} / ${l1.bpmOut}`);
  ok(l1.hint.includes('原曲未定'), 'B1 拍号未测出时不撒谎', `提示「${l1.hint}」`);

  // ── 路线一：只精修（同全长口径）
  await p.click('#btnProcess');
  await p.waitForFunction(() => { const x=document.querySelector('#btnProcess'); return x && !x.disabled && /完成|重新|执行/.test(x.textContent); }, { timeout: 180000 }).catch(()=>{});
  await p.waitForTimeout(800);
  await p.click('#btnRecheck');
  await p.waitForFunction(() => { const v=[...document.querySelectorAll('#checks .check-value')]; return v.length && v.every(x=>x.textContent.trim()!=='待执行'); }, { timeout: 120000 }).catch(()=>{});
  await p.waitForTimeout(700);
  const c1 = await checks();
  console.log('══ ② 精修-only 回流 ══');
  c1.forEach(c => console.log(`   ${c.cls} | ${c.n}: ${c.v} | ${c.note}`));
  ok(c1[1].note.includes('守住原作水准'), 'C1 精修走「守原作」口径', c1[1].note);

  // ── 路线二：渲染乐段（合成口径）
  await p.click('#btnRender');
  await p.waitForFunction(() => { const x=document.querySelector('#btnRender'); return x && (x.textContent.includes('重新渲染')||x.textContent.includes('失败')); }, { timeout: 120000 });
  await p.waitForTimeout(800);
  const l3 = await read();
  console.log('══ ③ 渲染后 ══', JSON.stringify(l3));
  ok(/未测出|体检/.test(l3.badgeTitle||''), 'B2 渲染后徽章出处诚实', `「${l3.badge}」→「${l3.badgeTitle}」`);

  await p.click('#btnRecheck');
  await p.waitForFunction(() => { const v=[...document.querySelectorAll('#checks .check-value')]; return v.length && v.every(x=>x.textContent.trim()!=='待执行'); }, { timeout: 120000 }).catch(()=>{});
  await p.waitForTimeout(700);
  const c2 = await checks();
  console.log('══ ④ 乐段回流 ══');
  c2.forEach(c => console.log(`   ${c.cls} | ${c.n}: ${c.v} | ${c.note}`));
  ok(!/退化|压得过平/.test(c2[1].note), 'D1 不再给合成乐段扣「退化」帽子', c2[1].note);
  ok(c2[1].note.includes('本机合成'), 'D2 乐段口径写明是自查', c2[1].note);
  const noteBpm = (c2[2].note.match(/([\d.]+)\s*BPM/) || [])[1];
  ok(noteBpm != null && Math.abs(parseFloat(noteBpm) - parseFloat(l1.mBpm)) < 0.05,
     'D3 结构项速度与体检一致', `L1 ${l1.mBpm} vs 回流 ${noteBpm} BPM`);
  ok(c2[1].cls === 'is-ok', 'D4 乐段音质项判过', `cls=${c2[1].cls}`);

  console.log('\n' + '─'.repeat(56));
  console.log(`${pass} 通过 / ${fail} 失败 · 报错 ${errs.length}`);
  errs.slice(0,10).forEach(e => console.log('  !', e));
  await p.screenshot({ path: '/tmp/sonic-shots/product/final-deliver.png' });
  await b.close();
  process.exit(fail || errs.length ? 1 : 0);
})();
