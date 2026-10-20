/* ============================================================
   音智新媒 · 分析 Worker（L1 体检 / 响度实测）
   引擎本身只读：importScripts 原样加载 engine.js，一行算法不改。
   搬线程的原因：E.analyze 与 E.measureLoudness 是纯 JS 同步重活，
   实测同尺寸素材分别卡主线程 1.3s / 0.25s，导入与精修后各跑一遍。
   E.process 依赖 OfflineAudioContext（实测 Worker 里不可用），
   留在主线程做离屏渲染，它本来就是异步出活的。
   ============================================================ */
'use strict';

importScripts('engine.js');

// engine 只读 sampleRate / length / numberOfChannels / duration / getChannelData，
// 把声道副本包成同形状对象即可，不必也不可用 AudioBuffer（Worker 里没有）
function fakeBuffer(channels, sampleRate, length) {
  return {
    sampleRate,
    length,
    numberOfChannels: channels.length,
    duration: sampleRate > 0 ? length / sampleRate : 0,
    getChannelData: (i) => channels[i],
  };
}

self.onmessage = (e) => {
  const { cmd, id, channels, sampleRate, length } = e.data || {};
  try {
    const buf = fakeBuffer(channels || [], sampleRate || 0, length || 0);
    let value;
    if (cmd === 'analyze') {
      value = { profile: self.SonicEngine.analyze(buf) };
    } else if (cmd === 'loudness') {
      value = { lufs: self.SonicEngine.measureLoudness(buf) };
    } else if (cmd === 'checkup') {
      // 导入与精修后都是「体检 + 响度」一起来：一次传声道，两份结果
      value = {
        profile: self.SonicEngine.analyze(buf),
        lufs: self.SonicEngine.measureLoudness(buf),
      };
    } else {
      throw new Error('未知命令: ' + cmd);
    }
    self.postMessage({ id, ok: true, value });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
