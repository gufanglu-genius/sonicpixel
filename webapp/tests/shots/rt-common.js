// common harness for runtime audit
const { chromium } = require('/Users/chenhuidediannao/.stepfun/node_modules/playwright-core');

const URL = 'http://127.0.0.1:8080/';
const EXEC = undefined; // use default from playwright-core

async function launch(opts = {}) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN ||
      '/Users/chenhuidediannao/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
    ...opts,
  });
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const logs = { console: [], pageerror: [], unhandled: [], downloads: [] };
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') logs.console.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => logs.pageerror.push(String(e.message || e)));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (!u.includes('fonts.g')) logs.console.push('[reqfail] ' + u + ' ' + (r.failure() && r.failure().errorText));
  });
  page.on('unhandledrejection', (r) => logs.unhandled.push(String(r)));
  await page.addInitScript(() => {
    window.__blobs = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      try { window.__blobs.push({ type: blob.type, size: blob.size }); } catch (_) {}
      return orig(blob);
    };
    window.addEventListener('unhandledrejection', (e) => {
      window.__unhandled = window.__unhandled || [];
      window.__unhandled.push(String(e.reason));
    });
  });
  return { browser, ctx, page, logs };
}

async function readBlobs(page) {
  return page.evaluate(async () => {
    const out = [];
    // re-grab via wrapping is not enough for text: patch anchor click to capture blob text
    return out;
  });
}

// capture blob text: wrap createObjectURL to stash the blob itself
async function installBlobCapture(page) {
  await page.addInitScript(() => {
    window.__blobData = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const rec = { type: blob.type, size: blob.size, name: '', text: null };
      window.__blobData.push(rec);
      if (blob.type && blob.type.includes('json')) {
        blob.text().then((t) => { rec.text = t; }).catch(() => {});
      }
      // capture the download name from the anchor
      setTimeout(() => {
        const anchors = document.querySelectorAll('a[download]');
        const last = anchors[anchors.length - 1];
        if (last) rec.name = last.getAttribute('download');
      }, 0);
      return orig(blob);
    };
  });
}

async function grabBlobs(page) {
  await page.waitForTimeout(300);
  return page.evaluate(() => (window.__blobData || []).map((b) => ({ type: b.type, size: b.size, name: b.name, text: b.text })));
}

async function text(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? el.textContent.trim() : null;
  }, sel);
}

async function waitIdleBtn(page, sel, doneRe, timeout = 120000) {
  await page.waitForFunction(
    ([s, re]) => {
      const b = document.querySelector(s);
      return b && !b.disabled && new RegExp(re).test(b.textContent);
    },
    [sel, doneRe],
    { timeout }
  );
}

module.exports = { launch, installBlobCapture, grabBlobs, text, waitIdleBtn, URL };
