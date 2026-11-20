/* ============================================================
   初团 · 大模型指令翻译（可选增强层）
   ------------------------------------------------------------
   只做一件事：把口语翻译成结构化 ops（BandParse 的 schema）。
   输出必须过 BandParse.validate，不合法直接丢弃并回落离线规则。
   API Key 放在 config.local.js（gitignore），页面没配 key 时
   整层自动降级为离线解析，产品照样完整可玩。
   ============================================================ */
(function (global) {
  'use strict';

  const SYSTEM = [
    '你是乐队总监的翻译官。把用户的中文指令翻译成编曲指令 JSON。',
    '只输出 JSON 数组，不要解释，不要 markdown 代码块。',
    '合法操作共 8 种：',
    '{"op":"mute","track":"lead|harm|bass|drums|pad","value":true} 停掉该轨；value:false 让该轨回来（「恢复」「回来」「继续」）',
    '{"op":"instrument","track":"lead|harm|bass|pad","value":音色} lead 可选 bell|flute|bamboo|harp|pluck|epiano|keys；harm 可选 strings|organ|harp|epiano|keys|pluck；bass 可选 finger|sub；pad 可选 warm|glass',
    '{"op":"style","value":"pop|ballad|guofeng|groove"} 整曲风格',
    '{"op":"intensity","value":0到1的数字} 整体强度，只在没点名轨、或点名鼓组的猛/收时用',
    '{"op":"tempo","value":40到200的整数} 绝对速度；「快一点」按当前速度加 8、「慢一点」减 8 后输出整数',
    '{"op":"trackLevel","track":"lead|harm|bass|drums|pad","value":0到1的数字} 单轨音量，1 为原样；「小点声」「轻一点」「收一点」点名了轨就用它，不是 mute',
    '{"op":"texture","track":"harm|bass|drums","value":织体模式} harm 为 chord|sustain|arp|stab，bass 为 whole|sparse|octave|root5，drums 为 studio|brush|wood|funk',
    '{"op":"density","track":"harm|bass|drums|pad","value":0到1的数字} 单轨疏密，越大音符越密，0.5 为中性',
    '示例：',
    '「鼓再猛一点」→ [{"op":"intensity","value":0.8}]',
    '「贝斯小点声」→ [{"op":"trackLevel","track":"bass","value":0.7}]（单轨音量，绝不是静音）',
    '「主旋律轻一点」→ [{"op":"trackLevel","track":"lead","value":0.7}]（不许动整曲 intensity）',
    '「把氛围去掉」→ [{"op":"mute","track":"pad","value":true}]；「氛围回来」→ [{"op":"mute","track":"pad","value":false}]',
    '「换竹箫」→ [{"op":"instrument","track":"lead","value":"bamboo"}]；「换电钢」→ [{"op":"instrument","track":"lead","value":"epiano"}]；「和声换风琴」→ [{"op":"instrument","track":"harm","value":"organ"}]',
    '「换笛子，别的不动」→ [{"op":"instrument","track":"lead","value":"flute"}]',
    '「来点国风」→ [{"op":"style","value":"guofeng"}]',
    '「和声换琶音」→ [{"op":"texture","track":"harm","value":"arp"}]（只输出这一条，不附带 intensity 或 style）',
    '「鼓密一点」→ [{"op":"density","track":"drums","value":0.7}]',
    '「换钢琴，再快一点」→ [{"op":"instrument","track":"lead","value":"keys"},{"op":"tempo","value":100}]',
    '只翻译这句话里明确说出来的改动；没点名的轨、没要求的强度与速度一律不输出，不要替用户加戏。',
    '「去掉/停/关掉」才是 mute；「小声/轻/收」是 trackLevel；「回来/恢复」是 mute:false。',
    '一句话可含多个操作。与音乐无关的请求输出 []。',
  ].join('\n');

  function cfg() {
    return global.BAND_CONFIG || {};
  }

  async function translate(text, state) {
    const c = cfg();
    if (!c.llmApiKey) return null;                       // 没 key：直接交离线
    const endpoint = c.llmEndpoint || 'https://api.xiaomimimo.com/v1/chat/completions';
    const model = c.llmModel || 'mimo-v2.6-flash';
    const history = (state && state.recent || []).map((h) => h + '。').join('');
    const body = {
      model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `当前状态：整体强度 ${(state && state.intensity != null ? state.intensity : 0.55).toFixed(2)}，速度 ${state && state.bpm || 92}，织体 ${JSON.stringify((state && state.texture) || {})}，疏密 ${JSON.stringify((state && state.density) || {})}，单轨音量 ${JSON.stringify((state && state.trackLevel) || {})}，静音 ${JSON.stringify((state && state.muted) || {})}。${history}用户说：${text}` },
      ],
      temperature: 0.1,
      max_tokens: 220,
    };
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);   // 8 秒没回就走离线，别让用户等
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.llmApiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = await res.json();
      const raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) return null;
      const ops = BandParse.validate(JSON.parse(match[0]));
      return ops.length ? ops : null;
    } catch (e) {
      return null;                                          // 网络/解析失败：静默降级
    }
  }

  /** 翻译入口：LLM 优先，失败回落离线规则。总是返回可用结果。 */
  async function understand(text, state) {
    const llmOps = await translate(text, state);
    if (llmOps && llmOps.length) return { ops: llmOps, via: 'llm' };
    const off = BandParse.offline(text, state);
    return { ops: off.ops, via: 'offline', reply: off.reply };
  }

  global.BandLLM = { understand, translate };
})(typeof window !== 'undefined' ? window : globalThis);
