# 测试与探针脚本

原先散在 `/tmp/sonic-shots/`（重启即失），2026-10-05 收进项目内。
脚本按来源分目录，`/tmp` 里的原目录结构在这里保持一致，跨文件相对引用不用改。

## 目录

| 目录 | 内容 |
|---|---|
| `guard-mode-structure.js` | **调式结构护栏**（纯 Node，无浏览器）。五声五调式 fixture 必须全绿；gong-harmonic 是**刻意保留的已知红**（G4/1176Hz 谐波落 chroma 带，宫被读成徵），不许为了让它变绿改引擎 |
| `probe-innovations.js` | **第一梯队创新·引擎侧探针**（纯 Node，秒级）：证据链字段 / BS.1770 响度已知值 / 响度对齐+峰值截断 / 五调式互转恒等·集合闭合·偏音直通 |
| `midi/` | `unit.js` 纯字节单测（SMF/ZIP 解析，Node 直跑）；`e2e.js` 浏览器端到端（分治/导出/恢复）；`probe-*.js` 拍号/相位/力度诊断探针 |
| `product/` | `verify-*.js` 产品验收：export / persist / realsong / demo / all / fixes / tonality / eq-preserve / **score**（原曲五线谱：卡片/buildScore 口径/画布非空/PNG 导出/MusicXML 结构与时值配平/卡片收起展开/页签仍是 5）/ **loudcurve**（响度走势：3 秒短时窗曲线/目标线/导出对齐后靠拢/只加不删）/ **innovations**（证据链·响度合规·盲听·结构重排·五调式试听·有据 AI，mock MiMo 接口）；`probe-refine-strength.js` 精修改动量量化（等响分带差，只测不判） |
| `shots/` | 早期截图与回归脚本（smoke/qa/regress/rt* 等），多为历史快照用途 |

## 运行前提

1. **本地静态服务**（脚本都打 `http://127.0.0.1:8080/`）：
   ```bash
   cd "/Users/chenhuidediannao/Desktop/技术类作品/音智新媒项目/webapp"
   python3 -m http.server 8080
   ```
2. **Playwright headless Chromium**（require 路径写死在这台机器上）：
   - 模块：`/Users/chenhuidediannao/.stepfun/node_modules/playwright-core`
   - 可执行：`~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell`
3. 真歌素材：`/Users/chenhuidediannao/Desktop/红头绳.wav`（verify-fixes / verify-all / verify-export 默认用它）。

## 跑法

```bash
node tests/guard-mode-structure.js        # 纯 Node，秒级；退出码 0=按预期（含已知红）/ 1=意外
node tests/midi/unit.js                   # 纯 Node，秒级
node tests/probe-innovations.js           # 纯 Node，秒级：响度/证据链/五调式引擎侧
node tests/product/verify-innovations.js  # 第一梯队创新全量验收（需 8080 服务）
node tests/product/verify-tonality.js     # 拍号+大/小调 UI
node tests/product/verify-eq-preserve.js  # 手动 EQ 不被切换吃掉
node tests/product/verify-fixes.js        # 速度接线 / 拍号出处诚实 / 回流
node tests/product/verify-score.js        # 原曲五线谱（卡片/buildScore/画布/PNG/MusicXML/收起展开/页签 5 个）
node tests/product/verify-loudcurve.js    # 响度走势（短时曲线/目标线/导出对齐靠拢/只加不删）
node tests/product/verify-realsong.js     # 真歌全链（最长，含导出+恢复）
node tests/midi/e2e.js                    # 分治 + MIDI/分轨导出 + 恢复
```

## 已知坑（写脚本前先读）

- `waitForFunction(fn, options)` 的 options 是**第 3 个参数**（`fn, null, opts`）；
  写成第 2 个会被当成 arg，静默用 30s 默认超时。
- **测恢复时 URL 不能带 `?fresh=1`**——它每次加载都清 IndexedDB。
  `?synth=1` 只在点「试跑示例」按钮的 `runDemo` 里生效，不是 boot 自动跑。
- 存盘 400ms 防抖，且 `#saveStatus` 文案每次保存都一样——等「已自动存盘」出现
  并不能证明**本次**改动已落库；改完状态再刷新前先等 ≥1.5s。
- `.eq-band` 输入在体检完成前就建好了；判断处方就绪要看
  `#sourceKind .chip` 是否有 2 个 **且** `#evTabs .chip` 有 5 个
  （第一梯队加了证据链，旧脚本只等前者会抢跑）。
- `raw.chroma` 是 `Float64Array`，没有 `.concat`——页面代码里要先
  `Array.from()`（drawEvMode 曾栽在这上面，报 `chroma.concat is not a function`）。
- `state.structHistory` 每项是**一份完整计划（段数组）**，存盘时要
  `map(plan => plan.map(seg => …))` 两层；拍成一层会存成 `[{}]`，恢复折叠必败。
- `verify-innovations.js` 的错误路径**刻意**打 401，控制台必报
  资源失败与 `[ai]` 错——fatal 过滤器要把这两类剔掉，别当页面错误。
- AI 消息打包契约（verify 用请求体断言锁着）：**system 只放五条引用铁律**，
  卷宗 JSON 只垫在本轮 user 消息里、历史轮次发纯问答。铁律正文里提到
  「【实测数据】」这个名字是正常指路，判「system 混入数据」要看
  `"bpm"`/`"素材"` 这类卷宗键，别拿名字字符串当证据。
- 拍号门位（`engine.js` estimateMeter `r2max < 0.24`）标定依据：
  真拍号 demo 0.276（mono mix）/0.296（ch0），无周期《红头绳》0.072，白噪 ≈0.01。
- `midi/e2e.js` 的截图/导出仍写 `/tmp/sonic-shots/`（临时产物，重启无妨）；
  `unit.js` 的 `out.zip` 落在 `midi/` 里，已被 `.gitignore` 挡住。
