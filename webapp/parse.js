/* ============================================================
   初团 · 指令解析
   ------------------------------------------------------------
   用户的一句话 → 结构化编曲指令 ops。两条路径共用同一 schema：
   1. parse.offline：本地规则（无网无 key 也能玩，测试与降级的底）
   2. llm.js：大模型翻译后仍要过 validate，不合 schema 一律丢弃
   即：大模型只做翻译，不做生成；执行永远是确定性的音乐系统。
   ============================================================ */
(function (global) {
  'use strict';

  const TRACK_WORDS = [
    ['drums', ['鼓', '鼓组', '节奏', '打击', '拍子', '心跳']],
    ['bass', ['贝斯', '低音', '低声部']],
    ['harm', ['和声', '和弦', '伴奏', '铺和']],
    ['pad', ['氛围', '铺底', '背景音', '空气']],
    ['lead', ['主旋', '旋律', '我的调子', '我的旋律', '人声']],
  ];

  const INST_BY_TRACK = {
    lead: [
      ['bell', ['铃', '八音盒', '音乐盒', '风铃']],
      ['bamboo', ['竹箫', '箫', '洞箫']],
      ['flute', ['笛', '长笛', '竹笛', '笛子']],
      ['harp', ['竖琴']],
      ['pluck', ['古筝', '筝', '琵琶', '扬琴', '拨弦', '吉他']],
      ['epiano', ['电钢', '电钢琴']],
      ['keys', ['钢琴', '琴键']],
    ],
    harm: [
      ['strings', ['弦乐', '提琴', '小提琴', '管弦']],
      ['organ', ['风琴', '管风琴', '簧风琴']],
      ['harp', ['竖琴']],
      ['epiano', ['电钢', '电钢琴']],
      ['keys', ['钢琴', '键盘']],
      ['pluck', ['古筝', '筝', '拨弦']],
    ],
    bass: [
      ['finger', ['电贝', '拨弦贝斯', '常规贝斯']],
      ['sub', ['超低', 'sub', '更深', '更沉', '低音炮']],
    ],
    pad: [
      ['glass', ['玻璃', '清透', '空灵', '星尘']],
      ['warm', ['温暖', '暖', '绒', '包裹']],
    ],
  };

  const STYLE_WORDS = [
    ['guofeng', ['国风', '民乐', '中国风', '古风', '东方']],
    ['ballad', ['抒情', '柔一点的风格', '慢歌', '安静的风格', '柔情']],
    ['groove', ['律动', '带感', ' funk', '放克', 'groove', '摇起来']],
    ['pop', ['流行', '大众', '流行风']],
  ];

  /* 批次8：单轨织体词表。三轨的模式集合互不相交，没点名轨时
     可由词反推（琶音只可能是和声）；点名了轨就只查那一轨的池子，
     「旋律换琶音」这种无织体维度的组合直接不命中。 */
  const TEXTURE_WORDS = {
    harm: [
      ['arp', ['琶音', '分解和弦', '分解']],
      ['sustain', ['长音', '铺长音', '拉长音', '持续音']],
      ['chord', ['柱式', '柱式和弦', '齐奏']],
      ['stab', ['断奏', '顿音', '跳音']],
    ],
    bass: [
      ['whole', ['整音', '全音符', '长低音', '走根音']],
      ['octave', ['八度低音', '走八度', '八度']],
      ['root5', ['根五', '根音五度', '根音加五度']],
      ['sparse', ['稀疏', '简单低音', '低音简单']],
    ],
    drums: [
      ['brush', ['鼓刷', '轻刷', '软刷', '刷子', '用刷']],
      ['wood', ['木鱼', '敲木鱼']],
      ['funk', ['放克鼓', '放克', 'funk']],
      ['studio', ['流行鼓', '常规鼓', '标准鼓', '架子鼓']],
    ],
  };

  /* 单轨疏密：密/疏/稀。下调词先判（「不密」「别那么密」内含「密」），
     织体词命中后先从句子里剥掉再判，「贝斯稀疏」不会被拆成两半。 */
  const DENS_DOWN = ['疏', '稀', '不密', '别那么密', '别密', '太密'];
  const DENS_UP = ['密'];
  const DENSITY_TRACKS_OFFLINE = ['harm', 'bass', 'drums', 'pad'];

  function findTrack(text) {
    let best = null, bestLen = 0;
    for (const [id, words] of TRACK_WORDS) {
      for (const w of words) {
        if (text.includes(w) && w.length > bestLen) { best = id; bestLen = w.length; }
      }
    }
    return best;
  }

  function findInstrument(text, track) {
    // 全轨词表兜底：没点名轨时在所有乐器里找最具体的
    const pools = track
      ? [[track, INST_BY_TRACK[track] || []]]
      : Object.entries(INST_BY_TRACK);
    let best = null, bestTrack = null, bestLen = 0;
    for (const [tid, list] of pools) {
      for (const [inst, words] of list) {
        for (const w of words) {
          if (text.includes(w) && w.length > bestLen) { best = inst; bestTrack = tid; bestLen = w.length; }
        }
      }
    }
    return best ? { track: bestTrack, instrument: best } : null;
  }

  function findStyle(text) {
    for (const [id, words] of STYLE_WORDS) {
      for (const w of words) if (text.includes(w)) return { id, word: w };
    }
    return null;
  }

  function findTexture(text, track) {
    if (track && !TEXTURE_WORDS[track]) return null;   // 主旋/氛围没有织体维度
    const pools = track ? [[track, TEXTURE_WORDS[track]]] : Object.entries(TEXTURE_WORDS);
    let best = null, bestTrack = null, bestMode = null, bestLen = 0;
    for (const [tid, list] of pools) {
      for (const [mode, words] of list) {
        for (const w of words) {
          if (text.includes(w) && w.length > bestLen) { best = w; bestTrack = tid; bestMode = mode; bestLen = w.length; }
        }
      }
    }
    return best ? { track: bestTrack, mode: bestMode, word: best } : null;
  }

  function findDensity(text) {
    if (DENS_DOWN.some((w) => text.includes(w))) return 'down';
    if (DENS_UP.some((w) => text.includes(w))) return 'up';
    return null;
  }

  /* 相对强度台阶。中文口语几乎全是相对词，绝对值交给滑杆。 */
  const UP_WORDS = ['燃', '炸', '重', '猛', '强', '满', '冲', '爆', '用力', '带劲', '嗨'];
  const DOWN_WORDS = ['轻', '柔', '温柔', '弱', '收', '淡', '小声', '小点声', '调小', '声音小', '音量小', '轻一点', '舒缓', '安静'];
  const UP_MORE = ['再', '更', '加', '多'];
  const FAST_WORDS = ['快一点', '加速', '再快', '提速', '快起来', '紧凑'];
  const SLOW_WORDS = ['慢一点', '放慢', '放缓', '慢下来', '减速', '舒展'];
  const MUTE_WORDS = ['停', '去掉', '关掉', '不要', '别打', '消掉', '闭嘴', '下场'];
  const UNMUTE_WORDS = ['回来', '恢复', '加上', '重新打', '继续'];

  function clamp01(v) { return Math.round(Math.min(1, Math.max(0, v)) * 100) / 100; }

  /**
   * 解析一句话为 ops + 回复语。
   * 状态 state 只用于相对量的落点（如当前 intensity 0.4 + 两档）。
   */
  function offline(text, state) {
    const t = String(text || '').trim().toLowerCase();
    const st = state || {};
    const ops = [];
    const said = [];
    if (!t) return { ops, reply: '想让乐队怎么改？跟我说就好。' };

    const track = findTrack(t);
    const styleHit = findStyle(t);
    const inst = findInstrument(t, track);
    // 撞词裁决：「放克」既是律动风格也是鼓织体。点名了轨织体赢
    // （鼓换放克只换鼓），没点名风格赢（来个放克整曲切律动）；
    // 词不同则两个都出（「和声换琶音，来个国风」）。
    let texHit = findTexture(t, track);
    let style = styleHit ? styleHit.id : null;
    if (styleHit && texHit && styleHit.word.trim() === texHit.word.trim()) {
      if (track) style = null; else texHit = null;
    }

    // 停/恢复某轨
    if (track && MUTE_WORDS.some((w) => t.includes(w)) && !t.includes('不要停')) {
      ops.push({ op: 'mute', track, value: true });
      said.push('让' + trackName(track) + '先歇会儿');
    } else if (track && UNMUTE_WORDS.some((w) => t.includes(w)) && st.muted && st.muted[track]) {
      ops.push({ op: 'mute', track, value: false });
      said.push('让' + trackName(track) + '回来');
    }

    // 换乐器（轨内换音色）
    if (inst && !(style && !track)) {
      ops.push({ op: 'instrument', track: inst.track, value: inst.instrument });
      said.push('把' + trackName(inst.track) + '换成' + instName(inst.instrument));
    }

    // 单轨织体（批次8）
    if (texHit) {
      ops.push({ op: 'texture', track: texHit.track, value: texHit.mode });
      said.push('把' + trackName(texHit.track) + '织体换成' + texName(texHit.mode));
    }

    // 单轨疏密（批次8）：先剥掉织体词再判，密度要求点名轨
    const tDen = texHit ? t.replace(texHit.word, '') : t;
    const densTrack = findTrack(tDen) || track;
    if (densTrack && DENSITY_TRACKS_OFFLINE.includes(densTrack)) {
      const dir = findDensity(tDen);
      if (dir) {
        const cur = st.density && Number.isFinite(st.density[densTrack]) ? st.density[densTrack] : 0.5;
        const bump = UP_MORE.some((w) => tDen.includes(w)) ? 0.3 : 0.18;
        const v = clamp01(cur + (dir === 'up' ? bump : -bump));
        ops.push({ op: 'density', track: densTrack, value: v });
        said.push('把' + trackName(densTrack) + '疏密调到' + Math.round(v * 100));
      }
    }

    // 风格切换
    if (style) {
      ops.push({ op: 'style', value: style });
      said.push('整体换成' + styleName(style) + '的感觉');
    }

    // 强度（全局或对轨）
    const upHit = UP_WORDS.some((w) => t.includes(w));
    const downHit = DOWN_WORDS.some((w) => t.includes(w));
    if (upHit || downHit) {
      const bump = UP_MORE.some((w) => t.includes(w)) ? 0.3 : 0.18;
      if (track && !['drums'].includes(track) && downHit) {
        // 「旋律轻一点」是单轨力度，不动整曲强度
        ops.push({ op: 'trackLevel', track, value: clamp01((st.trackLevel && st.trackLevel[track] != null ? st.trackLevel[track] : 1) - bump) });
        said.push('把' + trackName(track) + '收一点');
      } else {
        const cur = Number.isFinite(st.intensity) ? st.intensity : 0.55;
        ops.push({ op: 'intensity', value: clamp01(cur + (upHit ? bump : -bump)) });
        said.push(upHit ? '鼓和贝斯推高一档' : '鼓和贝斯收一档');
      }
    }

    // 速度
    if (FAST_WORDS.some((w) => t.includes(w))) {
      const cur = Number.isFinite(st.bpm) ? st.bpm : 92;
      ops.push({ op: 'tempo', value: Math.min(160, cur + 8) });
      said.push('提速到 ' + Math.min(160, cur + 8));
    } else if (SLOW_WORDS.some((w) => t.includes(w))) {
      const cur = Number.isFinite(st.bpm) ? st.bpm : 92;
      ops.push({ op: 'tempo', value: Math.max(55, cur - 8) });
      said.push('放缓到 ' + Math.max(55, cur - 8));
    }

    if (!ops.length) {
      return { ops, reply: '这句我没听懂改什么。试试：鼓再重一点 / 换笛子 / 来个国风 / 慢一点。' };
    }
    return { ops, reply: '收到：' + said.join('，') + '。' };
  }

  function trackName(id) {
    return ({ lead: '主旋', harm: '和声', bass: '贝斯', drums: '鼓组', pad: '氛围' })[id] || id;
  }
  function instName(id) {
    return ({ bell: '铃', flute: '笛子', bamboo: '竹箫', harp: '竖琴', pluck: '古筝', keys: '钢琴', epiano: '电钢', organ: '风琴', strings: '弦乐', finger: '电贝斯', sub: '超低音', warm: '暖氛围', glass: '空灵氛围' })[id] || id;
  }
  function styleName(id) {
    return ({ pop: '流行', ballad: '抒情', guofeng: '国风', groove: '律动' })[id] || id;
  }
  function texName(id) {
    return ({
      chord: '柱式', sustain: '长音', arp: '琶音', stab: '断奏',
      whole: '整音', sparse: '稀疏', octave: '八度', root5: '根五',
      studio: '流行鼓', brush: '刷奏', wood: '木鱼', funk: '放克',
    })[id] || id;
  }

  /* ---------- schema 校验：LLM 输出也走这道门 ---------- */
  const OPS = new Set(['mute', 'instrument', 'style', 'intensity', 'tempo', 'trackLevel', 'texture', 'density']);
  const TRACKS = new Set(['lead', 'harm', 'bass', 'drums', 'pad']);
  const INSTS = new Set(['bell', 'flute', 'bamboo', 'harp', 'pluck', 'keys', 'epiano', 'organ', 'strings', 'finger', 'sub', 'warm', 'glass', 'kit']);
  const STYLES = new Set(['pop', 'ballad', 'guofeng', 'groove']);
  // 织体只有三轨有维度，模式集合与 band.js 的 TEXTURE_OPTS 同源
  const TEXTURE_BY_TRACK = {
    harm: new Set(['chord', 'sustain', 'arp', 'stab']),
    bass: new Set(['whole', 'sparse', 'octave', 'root5']),
    drums: new Set(['studio', 'brush', 'wood', 'funk']),
  };
  // 疏密四轨（主旋是用户旋律，不设密度）
  const DENSITY_TRACKS = new Set(['harm', 'bass', 'drums', 'pad']);

  function validate(ops) {
    if (!Array.isArray(ops)) return [];
    const out = [];
    for (const o of ops) {
      if (!o || typeof o !== 'object' || !OPS.has(o.op)) continue;
      if (o.op === 'mute' && TRACKS.has(o.track) && typeof o.value === 'boolean') out.push({ op: 'mute', track: o.track, value: o.value });
      else if (o.op === 'instrument' && TRACKS.has(o.track) && INSTS.has(o.value)) out.push({ op: 'instrument', track: o.track, value: o.value });
      else if (o.op === 'style' && STYLES.has(o.value)) out.push({ op: 'style', value: o.value });
      else if (o.op === 'intensity' && typeof o.value === 'number' && o.value >= 0 && o.value <= 1) out.push({ op: 'intensity', value: o.value });
      else if (o.op === 'tempo' && typeof o.value === 'number' && o.value >= 40 && o.value <= 200) out.push({ op: 'tempo', value: Math.round(o.value) });
      else if (o.op === 'trackLevel' && TRACKS.has(o.track) && typeof o.value === 'number' && o.value >= 0 && o.value <= 1) out.push({ op: 'trackLevel', track: o.track, value: o.value });
      else if (o.op === 'texture' && TEXTURE_BY_TRACK[o.track] && TEXTURE_BY_TRACK[o.track].has(o.value)) out.push({ op: 'texture', track: o.track, value: o.value });
      else if (o.op === 'density' && DENSITY_TRACKS.has(o.track) && typeof o.value === 'number' && o.value >= 0 && o.value <= 1) out.push({ op: 'density', track: o.track, value: o.value });
    }
    return out;
  }

  /* ---------- ops → 模型补丁（应用层共用） ---------- */
  function applyOps(model, ops) {
    let m = model;
    const trackLevel = {};
    for (const o of validate(ops)) {
      if (o.op === 'style') {
        // 换风格：整曲重编（音色、织体、疏密显式指定过的保留，
        // 没指定的随新风格缺省走；小节数不跳档）
        m = Band.compose({
          melodyItems: m.melodyItems, bpm: m.bpm, meter: m.meter, style: o.value,
          bars: m.bars,
          seed: m.seed, intensity: m.intensity, rootMidi: m.rootMidi, modeIndex: m.modeIndex,
          instruments: m.instruments, texture: m.texture, density: m.density,
          muted: m.muted, snap: m.snap,
        });
      } else if (o.op === 'tempo') {
        m = { ...m, bpm: o.value };
        // 速度只影响换算不需重编事件
      } else if (o.op === 'intensity') {
        // 全局强度影响鼓/贝斯密度 → 鼓与贝斯重生成，旋律和声不动
        m = Band.recomposeTrack(m, 'drums', { intensity: o.value });
        m = Band.recomposeTrack(m, 'bass', { intensity: o.value });
        m = { ...m, intensity: o.value };
      } else if (o.op === 'mute') {
        m = Band.recomposeTrack(m, o.track, { mute: o.value });
      } else if (o.op === 'instrument') {
        m = Band.recomposeTrack(m, o.track, { instrument: o.value });
      } else if (o.op === 'texture') {
        // 单轨织体：只重算目标轨，其余四轨引用原样
        m = Band.recomposeTrack(m, o.track, { texture: o.value });
      } else if (o.op === 'density') {
        // 单轨疏密：只重算目标轨；鼓与贝斯叠在全局强度上，互不清账
        m = Band.recomposeTrack(m, o.track, { density: o.value });
      } else if (o.op === 'trackLevel') {
        trackLevel[o.track] = o.value;
      }
    }
    return { model: m, trackLevel };
  }

  global.BandParse = { offline, validate, applyOps, trackName, instName, styleName, texName };
})(typeof window !== 'undefined' ? window : globalThis);
