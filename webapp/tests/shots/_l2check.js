const {chromium}=require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');
const EXEC='/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
(async()=>{
  const b=await chromium.launch({executablePath:EXEC,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
  const p=await b.newPage();
  p.on('pageerror',e=>console.log('PAGEERR', e.message));
  await p.goto('http://127.0.0.1:8080/?demo=1',{waitUntil:'networkidle'});
  await p.waitForFunction(()=>{
    const e=document.querySelector('#mThd');
    return e && e.textContent.trim() && e.textContent.trim()!=='—';
  },{timeout:30000}).catch(()=>console.log('(等体检超时)'));

  const grab=()=>p.evaluate(()=>{
    const g=(s)=>{const e=document.querySelector(s);return e?e.textContent.trim():null;};
    return {
      体检_残余:g('#mThd'), 体检_LRA:g('#mLra'), 体检_波峰:g('#mCrest'),
      体检_浑浊:g('#mMud'), 体检_亮度:g('#mCent'),
      精修区:g('#refineEmpty')? '(空)': '有内容',
      精修区文本:(document.querySelector('#sec-refine')||{}).innerText?.replace(/\s+/g,' ').slice(0,220),
    };
  });
  console.log('══ 体检后 ══');
  console.log(JSON.stringify(await grab(),null,1));

  const clicked=await p.evaluate(()=>{
    const b=[...document.querySelectorAll('button')].find(b=>/执行精修|重新精修/.test(b.textContent));
    if(!b) return '没找到精修按钮';
    b.click(); return b.id+' '+b.textContent.trim();
  });
  console.log('\n点精修:', clicked);
  await p.waitForTimeout(9000);
  console.log('\n══ 精修后 ══');
  console.log(JSON.stringify(await grab(),null,1));
  await p.screenshot({path:'/tmp/sonic-shots/out/l2-check.png', fullPage:true});
  await b.close();
})();
