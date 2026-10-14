/* ============================================================
   音智新媒 · 工作区持久化
   ------------------------------------------------------------
   存两样：源素材的原始字节，以及 L1/L2/L3 的参数与分析结果（JSON）。
   不存派生 PCM（processedBuffer / arrangement）。

   为什么这样分：
   · 源字节必须存。刷新之后浏览器再也没有权限读到用户上次选中的
     那个文件，示例曲又由 Math.random() 合成，不存字节就真的没了。
   · 派生 PCM 不存。process() 与 renderArrangement()（seed = 7）
     都是确定性的，由参数当场重算即可；4 分钟立体声 WAV16 约 25.7 MB，
     存参数比存 PCM 小一个数量级，还少一份会和参数脱节的数据。

   字节与会话分两个 object store：字节只在素材换掉时写一次，
   会话记录几十 KB，滑块拖动期间的去重写盘才付得起。
   ============================================================ */
(function () {
  'use strict';

  const DB_NAME = 'sonicpixel';
  const DB_VER = 1;
  const T_ASSETS = 'assets';
  const T_SESSION = 'session';
  const SESSION_KEY = 'current';
  /* 结构变了就把这个数字 +1：旧会话字段对不上时宁可当没有，
     也不能拿半截数据去恢复一个跑不起来的工作区。 */
  const SCHEMA = 1;
  /* 源文件直接按原样入库。超过这个尺寸就不存了——
     超大素材本来也多半是整轨备份，用户手上还有原文件。 */
  const MAX_BYTES = 120 * 1024 * 1024;

  let dbP = null;
  /* 已经写过的素材 id：同一首歌反复调参数时不再重复写几十 MB 字节 */
  let storedAssetId = null;

  function open() {
    if (dbP) return dbP;
    dbP = new Promise((res, rej) => {
      if (typeof indexedDB === 'undefined') { rej(new Error('本环境没有 IndexedDB')); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VER); }
      catch (err) { rej(err); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(T_ASSETS)) db.createObjectStore(T_ASSETS);
        if (!db.objectStoreNames.contains(T_SESSION)) db.createObjectStore(T_SESSION);
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error || new Error('IndexedDB 打开失败'));
      req.onblocked = () => rej(new Error('IndexedDB 被其他标签页占用'));
    });
    // 打不开就永远打不开，别让每次存盘都重试一遍再各自抛错
    dbP.catch(() => { dbP = null; });
    return dbP;
  }

  function put(store, key, value) {
    return open().then((db) => new Promise((res, rej) => {
      const r = db.transaction(store, 'readwrite').objectStore(store).put(value, key);
      r.onsuccess = () => res(true);
      r.onerror = () => rej(r.error);
    }));
  }

  function get(store, key) {
    return open().then((db) => new Promise((res, rej) => {
      const r = db.transaction(store, 'readonly').objectStore(store).get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  }

  function del(store, key) {
    return open().then((db) => new Promise((res, rej) => {
      const r = db.transaction(store, 'readwrite').objectStore(store).delete(key);
      r.onsuccess = () => res(true);
      r.onerror = () => rej(r.error);
    }));
  }

  /* 会话记录里不带 bytes：大对象只走 assets 那张表，
     会话表保持小体积，去重之后的写盘才便宜。 */
  function stripBytes(rec) {
    const out = {};
    Object.keys(rec).forEach((k) => { if (k !== 'bytes') out[k] = rec[k]; });
    out.schema = SCHEMA;
    out.savedAt = Date.now();
    return out;
  }

  /* 素材 id：必须能区分内容。示例曲每次合成的字节都不同、
     而 WAV 时长固定导致长度永远一样，光靠「文件名+长度」会把新曲当旧曲跳过写入。
     FNV-1a 只抽样 64K 个点，25 MB 量级约 1ms，足以挡掉这种误判。 */
  function fingerprint(bytes) {
    const view = new Uint8Array(bytes);
    let h = 2166136261 >>> 0;
    const step = Math.max(1, Math.floor(view.length / 65536));
    for (let i = 0; i < view.length; i += step) {
      h ^= view[i];
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(36) + '-' + view.length;
  }

  async function save(rec) {
    if (!rec || !rec.profile) return { ok: false, reason: 'no-session' };
    const bytes = rec.bytes;
    const id = rec.assetId;
    if (!id || !bytes) return { ok: false, reason: 'no-asset' };
    if (bytes.byteLength > MAX_BYTES) {
      return { ok: false, reason: 'too-large', bytes: bytes.byteLength };
    }
    if (id !== storedAssetId) {
      // 先写新的再删旧的：中途失败最多少删一个孤儿，不会把能恢复的那份删掉
      await put(T_ASSETS, id, bytes);
      if (storedAssetId) await del(T_ASSETS, storedAssetId).catch(() => {});
      storedAssetId = id;
    }
    await put(T_SESSION, SESSION_KEY, stripBytes(rec));
    return { ok: true, bytes: bytes.byteLength };
  }

  async function assetId(kind, name, bytes) {
    return kind + ':' + (name || '') + ':' + fingerprint(bytes);
  }

  async function load() {
    try {
      const s = await get(T_SESSION, SESSION_KEY);
      if (!s || s.schema !== SCHEMA) return null;
      if (!s.assetId || !s.profile) return null;
      const bytes = await get(T_ASSETS, s.assetId);
      // 素材比会话活得短（清缓存、被配额挤掉）时没有字节就恢复不了，
      // 与其给一个缺胳膊少腿的工作区，不如当没有过。
      if (!bytes || !bytes.byteLength) return null;
      storedAssetId = s.assetId;
      return Object.assign({}, s, { bytes });
    } catch (err) {
      console.info('[store] 恢复失败，按新会话开始', err);
      return null;
    }
  }

  async function clear() {
    try {
      await del(T_SESSION, SESSION_KEY);
      await del(T_ASSETS, storedAssetId || '');
      storedAssetId = null;
      return true;
    } catch (err) {
      console.info('[store] 清空失败', err);
      return false;
    }
  }

  window.SonicStore = { save, load, clear, assetId, MAX_BYTES };
})();
