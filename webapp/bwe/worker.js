// 处理 Worker：接收会话采样率 mono/立体声中置分量，内部 32k 恢复，
// 结果送回主线程。进度逐批 post；取消用主线程 terminate（无需 SharedArrayBuffer）。
import { restore, defaultConfig, identityLowbandDb, highBandEnergyRatio } from "./bwe.js";
import { toInternal32k, fromInternal32k } from "./resample.js";

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.cmd === "analyze") {
    // 只做守卫检测（不恢复）：重采样到 32k 后用与 restore 完全同口径的判据
    try {
      const x32 = toInternal32k(msg.channelData, msg.srSession);
      const cfg = defaultConfig();
      const guard = highBandEnergyRatio(x32, 32000, cfg.fc, cfg.he);
      self.postMessage({
        type: "analyzed",
        tag: msg.tag,
        guardRatio: guard,
        pass: guard <= cfg.hb_skip_ratio,
        threshold: cfg.hb_skip_ratio,
        durationS: msg.nSamples / msg.srSession,
      });
    } catch (err) {
      self.postMessage({ type: "error", message: String(err && err.message || err) });
    }
    return;
  }
  if (msg.cmd !== "restore") return;
  try {
    const { channelData, srSession, nSamples, tag } = msg;
    const x = channelData;                       // mono 或中置分量，会话采样率
    // 1) 采样率适配到 32k
    const x32 = toInternal32k(x, srSession);
    const cfg = defaultConfig();
    // 2) 信号级守卫（与 restore 内部同口径，提前给检测卡用也可以）
    const guard = highBandEnergyRatio(x32, 32000, cfg.fc, cfg.he);
    // 3) 恢复
    let lastP = -1;
    const t0 = Date.now();
    const { y, diag } = restore(x32, cfg, (done, total) => {
      const p = Math.round((done / total) * 1000) / 10;   // 0.1% 精度
      if (p !== lastP) {
        lastP = p;
        self.postMessage({ type: "progress", p, tag });
      }
    });
    // 4) 带内保持（恒等泄漏）与回升会话采样率
    const leakDb = identityLowbandDb(y, x32, cfg);
    const yBack = fromInternal32k(y, srSession, nSamples);
    let nWrite = 0;
    for (let t = 0; t < diag.nFrames; t++) if (!diag.abstained[t]) nWrite++;
    const confMean = diag.conf.reduce((a, b) => a + b, 0) / diag.nFrames;
    self.postMessage({
      type: "done",
      tag,
      y: yBack,
      diag: {
        coverage: diag.coverage,
        abstainFrac: 1 - diag.coverage,
        nWrite,
        nFrames: diag.nFrames,
        signalPassthrough: diag.signalPassthrough,
        guardRatio: diag.guardRatio,
        confMean,
        leakDb,
        ms: Date.now() - t0,
      },
    });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.message || err) });
  }
};
