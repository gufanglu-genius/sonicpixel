# 音智新媒 SonicPixel

**零后端的可解释音频体检与音乐资产再生平台** —— 纯浏览器运行，零安装，网络请求数 = 0，用户上传的音频不出本机。

**在线试用（打开即用，无需任何后端）**：
👉 https://gufanglu-genius.github.io/sonicpixel/

本仓库只收录**前端程序本身及其源代码**。

## 产品能力

四级流水线：**L1 体检 → L2 精修 → L3 再生 → L4 回流质检**（L4 回到 L1 闭环复查）

- **L1 体检**：BPM / 拍号 / 调式 / 大小调 / 响度等 10 项指标，5 页签字段级证据链；自动记谱出五线谱，可导出 PNG 与 MusicXML；结构划分与结构重排
- **L2 精修**：由实测读数生成诊断处方（前置滤波 / 动态均衡 / 谐波优化 / 动态还原）、素材分治（AI 生成音乐 / 真实录音）、高频重建前置级（8 kHz 以上带限的素材先重建高频再精修，帧级证据自检、修不了的部分自动放弃）、等响盲听 A/B、按 Spotify / Apple / YouTube / EBU 平台目标导出（峰值截断如实标注「峰值受限」）
- **L3 再生**：民族五声调式（宫商角徵羽）互转与同旋律试听、五轨编配（主旋 / 和声 / 贝斯 / 鼓组 / 氛围）+ 钢琴卷帘、四类导出（MIDI / 混音 WAV / 分轨 ZIP / 音乐档案 JSON）
- **L4 回流质检**：回流三项校验（调式一致性 / 音质达标 / 结构完整性），版本树记录每一步处理参数

导入支持 WAV / MP3 / FLAC / OGG / M4A / AAC / AIFF / APE 八格式，内置真歌示例《龙城风·巷砖记》，以及「30 秒体验高频重建」一键演示（内置带限小号，自动跑体检 → 重建 → 启用 → 精修）。

## 仓库结构

```
├── index.html          入口跳转页（自动进入 webapp/，保证在线链接可用）
├── webapp/             前端程序与全部源代码
│   ├── index.html / app.js / engine.js / store.js / styles.css / extra.css / engineWorker.js
│   ├── bwe/            高频重建（TCS-BWE）算法与 Worker
│   ├── assets/         内置示例素材与静态资源
│   └── tests/          自动化测试（verify 验收套件与 probe 探针，含运行说明）
└── LICENSE             MIT 开源协议
```

## 本地运行（无需后端）

```bash
git clone https://github.com/gufanglu-genius/sonicpixel.git
cd sonicpixel/webapp
python3 -m http.server 8080
# 打开 http://127.0.0.1:8080/
```

## 自动化测试

纯 Node、任何机器可直接跑的部分：

```bash
node webapp/tests/guard-mode-structure.js   # 调式护栏（含 1 项刻意保留的已知红）
node webapp/tests/midi/unit.js              # MIDI/ZIP 字节级单测
node webapp/tests/probe-innovations.js      # 响度/证据链/五调式引擎侧探针
```

其余产品验收套件（`webapp/tests/product/verify-*.js`）需要本地 8080 静态服务 + Playwright headless Chromium，运行前提与完整清单见 [webapp/tests/README.md](webapp/tests/README.md)。

## ⚠️ 功能实现层级与后端依赖标注

| 功能 | 实现层 | 说明 |
|---|---|---|
| 体检 / 记谱 / 精修 / 再生 / 回流质检、四类导出、本地存盘、全部测试 | ✅ **纯前端，无需后端** | 浏览器内 OfflineAudioContext 全本地计算，GitHub Pages 打开即用，可断网演示 |
| 有据 AI 深度问答 | 🟡 **默认纯前端直连** | 浏览器直连模型官方接口，API Key 只存本机 localStorage。**若所选接口不开放浏览器跨域（CORS），或需要服务端托管密钥 → 需要自行部署后端代理后使用**（应用内「接口设置」填入代理地址即可） |
| 图像降噪 / 音频增强等服务端 AI 推理能力 | 🔧 **需要后端部署后使用** | 属 PyTorch 服务端推理，浏览器无法实现；**该部分不在本仓库收录范围内**（本仓库仅前端程序与源码） |

一句话总结：**本仓库收录的全部功能开箱即用；凡无法在前端实现的服务端 AI 能力，均需部署后端后方可使用（不在本仓库）。**

## 隐私声明

- 零后端、零网络请求：音频、档案、API Key 全部只存在你自己的浏览器（IndexedDB / localStorage）中；
- 在线版不会向任何服务器发送你的音频数据。

## 开源协议

[MIT](LICENSE) © 陈牧函（南通大学）
