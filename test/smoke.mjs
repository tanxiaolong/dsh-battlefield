/**
 * dsh-battlefield — 无浏览器冒烟测试。
 *
 * 插件真正的运行时是浏览器，而客户端模块**加载失败是静默的**：界面没变化时
 * 你分不清是「没加载」还是「加载了但白屏」。所以这里用一个极小的假 DOM 把
 * client.js 真跑一遍：apply → 派发按键 → 断言统计与 DOM。
 *
 * 覆盖的正是最容易出事的几类：
 *   - 严格模式下未声明就使用的变量（`new Function` 里加了 "use strict" 一样会抛）
 *   - 修饰键混进 dwell 统计（按住 ⌘ 两秒会把平均值彻底带偏）
 *   - 长按 repeat 被当成多次独立击键
 *   - 只按下不松手（keydown 没配到 keyup）导致计数虚高
 *   - dispose 之后节点/监听残留（热更会叠出第二个悬浮窗）
 *   - 枪声：未开不建 AudioContext、开了才拉样本、力度选枪型、修饰键不响、闲置挂起
 */

import { readFileSync } from 'node:fs';

/* --------------------------------------------------------------- 假 DOM */

function createElement(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    parentNode: null,
    attributes: Object.create(null),
    listeners: Object.create(null),
    style: Object.create(null),
    className: '',
    id: '',
    title: '',
    type: '',
    textContent: '',
    get firstChild() {
      return node.childNodes.length > 0 ? node.childNodes[0] : null;
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = node;
      node.childNodes.push(child);
      return child;
    },
    removeChild(child) {
      const index = node.childNodes.indexOf(child);
      if (index >= 0) node.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(name, value) {
      node.attributes[name] = String(value);
    },
    getAttribute(name) {
      return name in node.attributes ? node.attributes[name] : null;
    },
    addEventListener(type, handler) {
      if (!node.listeners[type]) node.listeners[type] = [];
      node.listeners[type].push(handler);
    },
    removeEventListener(type, handler) {
      const list = node.listeners[type];
      if (!list) return;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type, event) {
      const list = node.listeners[type] || [];
      for (const handler of list.slice()) handler(event);
    },
    closest() {
      return null;
    },
  };
  return node;
}

function createEnvironment() {
  const head = createElement('head');
  const body = createElement('body');
  const docListeners = Object.create(null);
  const winListeners = Object.create(null);
  const store = new Map();

  const document = {
    head,
    body,
    createElement,
    addEventListener(type, handler) {
      if (!docListeners[type]) docListeners[type] = [];
      docListeners[type].push(handler);
    },
    removeEventListener(type, handler) {
      const list = docListeners[type];
      if (!list) return;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    getElementById(id) {
      const walk = (node) => {
        if (node.id === id) return node;
        for (const child of node.childNodes) {
          const hit = walk(child);
          if (hit) return hit;
        }
        return null;
      };
      return walk(body) || walk(head);
    },
    querySelector() {
      return null;
    },
  };

  const clock = { value: 1000 };

  const window = {
    innerWidth: 1440,
    innerHeight: 900,
    localStorage: {
      getItem(key) {
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        store.set(key, String(value));
      },
      removeItem(key) {
        store.delete(key);
      },
    },
    addEventListener(type, handler) {
      if (!winListeners[type]) winListeners[type] = [];
      winListeners[type].push(handler);
    },
    removeEventListener(type, handler) {
      const list = winListeners[type];
      if (!list) return;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type, event) {
      const list = winListeners[type] || [];
      for (const handler of list.slice()) handler(event);
    },
    listenerCount(type) {
      return (winListeners[type] || []).length;
    },
  };

  const performance = { now: () => clock.value };

  // 假 Web Audio：只为断言「什么时候创建、放了几枪、放的哪一族」，不做真解码。
  const audio = { stops: [], created: 0, decoded: 0, played: [], fetched: [], suspended: 0, closed: 0, payloads: [], shaper: 0, curves: [], scalers: [], cancelRamps: 0, pans: [], convolvers: 0, convolverNodes: [], buffers: [] };
  class FakeAudioContext {
    constructor() {
      audio.created += 1;
      this.state = 'running';
      this.destination = { connect() {}, disconnect() {} };
    }
    get currentTime() {
      return clock.value / 1000;
    }
    createBufferSource() {
      const node = {
        buffer: null,
        playbackRate: { value: 1 },
        onended: null,
        connect() {},
        disconnect() {},
        start(when, offset, window) {
          audio.played.push({
            name: node.buffer ? node.buffer.name : '(none)',
            rate: node.playbackRate.value,
            envelope: node.__envelope === undefined ? '(none)' : node.__envelope,
            duration: node.buffer ? node.buffer.duration : 0,
            offset: typeof offset === 'number' ? offset : null,
            window: typeof window === 'number' ? window : null,
          });
        },
        stop() {
          audio.stops.push({ name: node.buffer ? node.buffer.name : '(none)', duration: node.buffer ? node.buffer.duration : 0 });
          if (typeof node.onended === 'function') node.onended();
        },
      };
      return node;
    }
    createBiquadFilter() {
      return { type: '', frequency: { value: 0 }, Q: { value: 0 }, connect() {}, disconnect() {} };
    }
    createGain() {
      const node = {
        gain: {
          value: 1,
          cancelScheduledValues() {
            audio.cancelRamps += 1;
          },
          setValueAtTime(value) {
            this.value = value;
          },
          linearRampToValueAtTime(value) {
            this.value = value;
          },
          exponentialRampToValueAtTime(value) {
            this.value = value;
          },
        },
        connect() {},
        disconnect() {},
      };
      audio.scalers.push(node.gain);
      return node;
    }
    createStereoPanner() {
      const pan = {
        value: 0,
        setValueAtTime(value) {
          this.value = value;
          audio.pans.push(['set', value]);
        },
        linearRampToValueAtTime(value) {
          this.value = value;
          audio.pans.push(['ramp', value]);
        },
      };
      return { pan, connect() {}, disconnect() {} };
    }
    createBuffer(channels, length, rate) {
      const channelsData = Array.from({ length: channels }, () => new Float32Array(length));
      const buffer = {
        numberOfChannels: channels,
        length,
        sampleRate: rate,
        duration: length / rate,
        getChannelData: (index) => channelsData[index],
      };
      audio.buffers.push(buffer);
      return buffer;
    }
    createConvolver() {
      audio.convolvers += 1;
      const node = { buffer: null, normalize: true, connect() {}, disconnect() {} };
      audio.convolverNodes.push(node);
      return node;
    }
    createWaveShaper() {
      audio.shaper += 1;
      const node = { curve: null, oversample: 'none', connect() {}, disconnect() {} };
      audio.curves.push(node);
      return node;
    }
    decodeAudioData(bytes, ok) {
      const view = new Uint8Array(bytes);
      audio.payloads.push({
        magic: String.fromCharCode(view[0], view[1], view[2], view[3]),
        size: view.length,
      });
      // 长尾层（0.70–1.90 秒），数值来自 sfx/boom-*.ogg 的实测时长。
      const LONG_DURATIONS = {
        'long-1': 0.55, 'long-2': 0.55, 'long-3': 0.5, 'long-4': 0.55, 'long-5': 0.58,
        'long-6': 0.6, 'long-7': 0.6, 'long-8': 0.6, 'long-9': 0.6, 'long-10': 0.55,
      };
      const BOOM_DURATIONS = {
        'boom-1': 1.6, 'boom-2': 1.9, 'boom-3': 1.9, 'boom-4': 1.25,
        'boom-5': 1.6, 'boom-6': 1.6, 'boom-7': 1.6,
      };
      // 样本是内联 base64，没有文件名可带走：按解码顺序标记，顺序见 client.js 的 SFX_LIBRARY。
      const order = [
        'blast-1', 'blast-2', 'blast-3', 'blast-4', 'blast-5', 'blast-6',
        'wall-1', 'wall-2', 'wall-3', 'wall-4', 'wall-5',
        'miss-1', 'miss-2', 'miss-3',
        'ram-1', 'ram-2', 'ram-3', 'ram-4',
        'heavy-1', 'heavy-2', 'heavy-3', 'heavy-4',
        'far-1', 'far-2', 'far-3', 'far-4',
        'long-1', 'long-2', 'long-3', 'long-4', 'long-5',
        'long-6', 'long-7', 'long-8', 'long-9', 'long-10',
        'boom-1', 'boom-2', 'boom-3', 'boom-4', 'boom-5', 'boom-6', 'boom-7',
        'roger-1',
        // 氛围层：按需解码，所以排在 44 个之后
        'siren-1', 'plane-1', 'radio-1',
      ];
      const name = order[audio.decoded] || '(unknown)';
      audio.decoded += 1;
      const buffer = {
        name,
        duration:
          name === 'siren-1' ? 54.06
            : name === 'plane-1' ? 25.37
              : name === 'radio-1' ? 54.53
                : name === 'roger-1' ? 0.885
                  : LONG_DURATIONS[name] !== undefined ? LONG_DURATIONS[name]
                  : BOOM_DURATIONS[name] !== undefined ? BOOM_DURATIONS[name]
                  : name.startsWith('heavy') ? 0.9
                    : name.startsWith('far') ? 1.2
                      : name.startsWith('miss') ? 0.24
                        : name.startsWith('blast') || name.startsWith('wall') || name.startsWith('ram') ? 0.3
                          : 0.42,
      };
      if (typeof ok === 'function') ok(buffer);
      return Promise.resolve(buffer);
    }
    suspend() {
      this.state = 'suspended';
      audio.suspended += 1;
      return Promise.resolve();
    }
    resume() {
      this.state = 'running';
      return Promise.resolve();
    }
    close() {
      audio.closed += 1;
      return Promise.resolve();
    }
  }
  window.AudioContext = FakeAudioContext;
  window.fetch = async (url) => {
    audio.fetched.push(url);
    return { ok: true, arrayBuffer: async () => ({ name: url }) };
  };

  // 假定时器：真的记账，才能断言「不打字时一个定时器都没有」
  const intervals = new Map();
  const timeouts = new Map();
  let timerSeq = 1;

  const setTimeoutFake = (fn) => {
    const id = timerSeq;
    timerSeq += 1;
    timeouts.set(id, fn);
    return id;
  };
  const clearTimeoutFake = (id) => {
    timeouts.delete(id);
  };
  const setIntervalFake = (fn) => {
    const id = timerSeq;
    timerSeq += 1;
    intervals.set(id, fn);
    return id;
  };
  const clearIntervalFake = (id) => {
    intervals.delete(id);
  };
  const flushTimeouts = () => {
    const pending = [...timeouts.entries()];
    timeouts.clear();
    for (const entry of pending) entry[1]();
  };

  const logs = [];
  const quietConsole = {
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
    log: (...args) => logs.push(['log', ...args]),
  };

  return {
    document,
    window,
    audio,
    performance,
    setTimeoutFake,
    clearTimeoutFake,
    setIntervalFake,
    clearIntervalFake,
    flushTimeouts,
    intervals,
    timeouts,
    clock,
    logs,
    quietConsole,
    store,
  };
}

/* ----------------------------------------------------------------- 断言 */

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(name + (detail === undefined ? '' : ' — ' + detail));
}

function near(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= tolerance;
}

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes) walk(child, visit);
}

function collect(node, predicate) {
  const out = [];
  walk(node, (item) => {
    if (predicate(item)) out.push(item);
  });
  return out;
}

/* ------------------------------------------------------------------ 主体 */

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

const env = createEnvironment();
env.window.__ModuleLoader__ = {
  load(module) {
    env.loaded = module;
  },
};

const factoryCall = new Function(
  'window',
  'document',
  'performance',
  'console',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'fetch',
  '"use strict";\n' + source,
);

factoryCall(
  env.window,
  env.document,
  env.performance,
  env.quietConsole,
  env.setTimeoutFake,
  env.clearTimeoutFake,
  env.setIntervalFake,
  env.clearIntervalFake,
  env.window.fetch,
);

check('模块通过 __ModuleLoader__.load 注册', env.loaded !== undefined);
check('注册 id 逐字等于包名', env.loaded && env.loaded.id === 'dsh-battlefield');

const pluginModule = env.loaded.factory();
check('factory 返回 name', pluginModule.name === 'dsh-battlefield');
check('inject 为空数组（不依赖宿主服务，不会拖崩客户端）', Array.isArray(pluginModule.inject) && pluginModule.inject.length === 0);

const disposePlugin = pluginModule.apply();
check('apply 返回 dispose 函数', typeof disposePlugin === 'function');

const instance = env.window.__DSH_BATTLEFIELD__;
check('刚挂载时一条氛围录音都不解（省内存）', Object.keys(instance.sfx.ambienceInfo()).every((k) => instance.sfx.ambienceInfo()[k] === 0), JSON.stringify(instance.sfx.ambienceInfo()));
check('apply 之后实例挂到 window', instance !== undefined);
check('DOM 出现 dbf-root', env.document.getElementById('dbf-root') !== null);

const tiles = collect(env.document.body, (node) => node.className === 'dbf-key');
check('键盘 60 颗键位全部渲染', tiles.length === 60, '实际 ' + tiles.length);

const root = env.document.getElementById('dbf-root');
check('默认展开', root.getAttribute('data-mode') === 'open');
check('默认不暂停', root.getAttribute('data-paused') === '0');
check('默认可见', root.getAttribute('data-hidden') === '0');
check('挂载写入版本探针（localStorage，不发网络）', env.store.has('dsh-battlefield.mount.v1'), [...env.store.keys()].join(','));
check('静止时一个定时器都没跑（不吃 CPU）', env.intervals.size === 0, '实际 ' + env.intervals.size + ' 个');

/* ---- 派发按键 ---- */

function fire(type, code, at, extra) {
  env.clock.value = at;
  const event = {
    code,
    key: extra && extra.key !== undefined ? extra.key : '',
    timeStamp: at,
    repeat: extra && extra.repeat === true,
    shiftKey: extra ? extra.shiftKey === true : false,
    metaKey: extra ? extra.metaKey === true : false,
    ctrlKey: extra ? extra.ctrlKey === true : false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  env.window.dispatch(type, event);
  return event;
}

const engine = instance.engine;
const intervalsBeforeKey = env.intervals.size;

// A：按下 90ms
fire('keydown', 'KeyA', 5000);
check('按键后刷新定时器启动', env.intervals.size === intervalsBeforeKey + 1, '实际 ' + env.intervals.size);
fire('keyup', 'KeyA', 5090);
let last = engine.snapshot(5090).last;
check('keyup 结算出按下时长 90ms', near(last.dwell, 90, 0.001), '实际 ' + (last && last.dwell));
check('首次计时冲击力落在 1–99', Number.isInteger(last.impact) && last.impact >= 1 && last.impact <= 99, '实际 ' + last.impact);

// B：按下 130ms
fire('keydown', 'KeyB', 5200);
fire('keyup', 'KeyB', 5330);

// ⌘ 按住 700ms —— 必须只算击键数，不进 dwell 统计
fire('keydown', 'MetaLeft', 5400);
fire('keyup', 'MetaLeft', 6100);
last = engine.snapshot(6100).last;
check('修饰键记录标记为 modifier', last.isModifier === true);
check('修饰键冲击力为 0（不参与评分）', last.impact === 0, '实际 ' + last.impact);

// 长按 repeat：不能多算
fire('keydown', 'KeyC', 6200);
fire('keydown', 'KeyC', 6250, { repeat: true });
fire('keyup', 'KeyC', 6260);

// 只按下不松手：不能虚增计数
fire('keydown', 'KeyD', 6300);

// 没有 keydown 配对的 keyup：必须被忽略
fire('keyup', 'KeyZ', 6350);

const snap = engine.snapshot(6400);
check('总击键 4（含修饰键）', snap.total === 4, '实际 ' + snap.total);
check('有效计时击键 3（排除 ⌘）', snap.typed === 3, '实际 ' + snap.typed);
check('按住未松的 KeyD 不计入', snap.typed === 3);
check('无配对的 keyup 被忽略', engine.perKey.get('KeyZ') === undefined);
check('平均按下时长 = (90+130+60)/3', near(snap.mean, 93.333, 0.01), '实际 ' + snap.mean);
check('峰值 = 130', near(snap.max, 130, 0.001), '实际 ' + snap.max);
check('直方图总量 = 计时样本数', snap.hist.reduce((a, b) => a + b, 0) === 3);
check('修饰键没污染均值（均值 < 200）', snap.mean < 200, '实际 ' + snap.mean);
check('此刻有 1 颗键处于按下状态', snap.held === 1, '实际 ' + snap.held);

// 释放残留
fire('keyup', 'KeyD', 7000);

check('三颗键都有独立统计', ['KeyA', 'KeyB', 'KeyC'].every((code) => engine.perKey.has(code)));
check('KeyB 的 dwell 记录正确', near(engine.perKey.get('KeyB').lastDwell, 130, 0.001));
check('KeyC 只被记一次（repeat 被忽略）', engine.perKey.get('KeyC').n === 1, '实际 ' + engine.perKey.get('KeyC').n);
check('KeyA 的 dwell 记录未被覆盖', near(engine.perKey.get('KeyA').lastDwell, 90, 0.001));

/* ---- 渲染 ---- */

instance.view.tick();

const footLife = env.document.getElementById('dbf-foot-life');
check('页脚显示累计击键', footLife !== null && /累计/.test(footLife.textContent), footLife && footLife.textContent);

const totalCell = collect(env.document.body, (node) => node.className === 'dbf-cell')[0];
check('统计格已渲染', totalCell !== undefined);

const histBars = collect(env.document.body, (node) => node.className === 'dbf-hbar');
check('直方图 25 桶全部渲染', histBars.length === 25, '实际 ' + histBars.length);
check('有数据的桶被标为 hot', histBars.some((bar) => bar.getAttribute('data-hot') === '1'));

const boardTiles = collect(env.document.body, (node) => node.className === 'dbf-key' && node.getAttribute('data-hot') === '1');
check('敲过的键被点亮', boardTiles.length >= 3, '实际 ' + boardTiles.length);

/* ---- 快捷键折叠 / 展开 ---- */

fire('keydown', 'KeyB', 7100, { key: 'b', shiftKey: true, metaKey: true });
check('⌘⇧B 收起为角落按钮', root.getAttribute('data-hidden') === '1');
const pill = env.document.getElementById('dbf-pill');
check('收起后角落按钮可见', pill !== null && pill.getAttribute('data-hidden') === '0');
check('收起时不刷新（定时器清空）', env.intervals.size === 0, '实际 ' + env.intervals.size);
fire('keydown', 'KeyB', 7200, { key: 'b', shiftKey: true, metaKey: true });
check('再按一次恢复悬浮窗', root.getAttribute('data-hidden') === '0');

/* ---- 失焦清空未松开的键 ---- */

fire('keydown', 'KeyE', 7300);
check('按下后有键处于 held', engine.snapshot(7300).held >= 1, '实际 ' + engine.snapshot(7300).held);
env.window.dispatch('blur', {});
check('失焦后没有卡住的按键', engine.snapshot(7400).held === 0);

/* ---- 空闲自动休眠 ---- */

check('打字期间定时器在跑', env.intervals.size > 0, '实际 ' + env.intervals.size);
env.flushTimeouts();
check('停手 1.5 秒后定时器全部清空', env.intervals.size === 0, '实际 ' + env.intervals.size);

/* ---- 暂停 ---- */

engine.setPaused(true);
const frozen = engine.snapshot(7450).total;
fire('keydown', 'KeyF', 7460);
fire('keyup', 'KeyF', 7560);
check('暂停时不再计数', engine.snapshot(7600).total === frozen, '冻结值 ' + frozen);
engine.setPaused(false);

/* ---- 重置 ---- */

engine.reset();
instance.view.tick();
const afterReset = engine.snapshot(7700);
check('重置后总击键归零', afterReset.total === 0);
check('重置后均值归零', afterReset.mean === 0);
check('重置后直方图清空', afterReset.hist.every((value) => value === 0));
check('累计击键已落盘', env.store.has('dsh-battlefield.lifetime.v1'));

/* ---- 枪声 ---- */

const audio = env.audio;
const sfxButton = collect(env.document.body, (node) => node.className === 'dbf-btn' && node.textContent === '🔇')[0];
check('默认枪声关闭（按钮是 🔇）', sfxButton !== undefined);
check('未开声音时不创建 AudioContext', audio.created === 0, '实际 ' + audio.created);
check('未开声音时声轨不显示', root.getAttribute('data-sfx') === '0');

sfxButton.listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
check('点开后按钮变 🔊', sfxButton.textContent === '🔊', sfxButton.textContent);
check('点开后声轨显示', root.getAttribute('data-sfx') === '1');
check('开关状态落盘（只写 localStorage）', JSON.parse(env.store.get('dsh-battlefield.sfx.v1')).enabled === true);

// 解码是异步的：等一轮微任务 + 一轮宏任务
await new Promise((resolve) => setTimeout(resolve, 0));
check('44 个内联样本全部解码', audio.decoded === 44, '实际 ' + audio.decoded);
check('取样本不发任何网络请求', audio.fetched.length === 0, '实际 ' + audio.fetched.length + ' 次 fetch');
check('内联样本是有效 Ogg（魔数 OggS）', audio.payloads.every((p) => p.magic === 'OggS'), JSON.stringify(audio.payloads[0]));
check('内联样本体积正常（每个 > 4KB）', audio.payloads.every((p) => p.size > 4000), JSON.stringify(audio.payloads.map((p) => p.size)));
check('打开开关后自动试一枪（主层一发，长尾层最多叠一发）', audio.played.filter((shot) => !/^boom/.test(shot.name)).length === 1 && audio.played.length <= 2, JSON.stringify(audio.played));

instance.view.tick();
const sfxState = env.document.getElementById('dbf-sfx-state');
check('面板显示音频链路「就绪」', sfxState && sfxState.textContent === '就绪', sfxState ? sfxState.textContent : '(缺失)');
check('主链挂了软削波（推得响又不削波）', audio.shaper === 1, '实际 ' + audio.shaper);
{
  const hasScaler = audio.scalers.some((gain) => Math.abs(gain.value - 0.25) < 1e-9);
  check('软削波前有 1/4 缩放（把 ±4 压进 ±1 定义域）', hasScaler, audio.scalers.map((gain) => gain.value).join(','));
}
{
  const curve = audio.curves[0] && audio.curves[0].curve;
  const ceiling = 0.9;
  let max = 0;
  for (let i = 0; curve && i < curve.length; i += 1) max = Math.max(max, Math.abs(curve[i]));
  check('软削波曲线 2048 点', !!curve && curve.length === 2048, curve ? String(curve.length) : '(缺失)');
  check('曲线不越天花板 0.90', max <= ceiling + 1e-6, '实际 ' + max.toFixed(4));
  check('软削波不做过采样（4x 会振铃顶爆峰）', !!audio.curves[0] && audio.curves[0].oversample === 'none', audio.curves[0] ? audio.curves[0].oversample : '(缺失)');
}

check('主链挂了共享混响（所有声部落在同一个空间里）', audio.convolvers === 1, '实际 ' + audio.convolvers);
check('自报主链信息（混响 + 长尾样本）', instance.sfx.chainInfo().reverb === true && instance.sfx.chainInfo().tail === 7, JSON.stringify(instance.sfx.chainInfo()));
{
  const ir = audio.convolverNodes[0] && audio.convolverNodes[0].buffer;
  check(
    '混响脉冲响应是 0.55 秒立体声（小房间，不是大厅）',
    !!ir && ir.numberOfChannels === 2 && Math.abs(ir.duration - 0.55) < 0.02,
    ir ? ir.duration.toFixed(3) + 's / ' + ir.numberOfChannels + 'ch' : '(缺失)',
  );
}
check('默认火力档位是「激烈」', instance.sfx.presetName() === '激烈', instance.sfx.presetName());
const fireBtn = collect(env.document.body, (node) => node.tagName === 'BUTTON' && node.textContent === '🔥')[0];
fireBtn.listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
check('点 🔥 切到「失控」', instance.sfx.presetName() === '失控', instance.sfx.presetName());
check('档位写进设置', JSON.parse(env.store.get('dsh-battlefield.sfx.v1')).preset === 2);
fireBtn.listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
check('第三档是「标准」', instance.sfx.presetName() === '标准', instance.sfx.presetName());
fireBtn.listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
check('三档循环回「激烈」', instance.sfx.presetName() === '激烈', instance.sfx.presetName());

// 先热 10 下把均值/标准差喂起来：冲击力要看「比自己平时更重」，没有历史就一律 50。
for (let i = 0; i < 10; i += 1) {
  const code = 'Digit' + i;
  fire('keydown', code, 8200 + i * 160);
  fire('keyup', code, 8300 + i * 160);
}
audio.played.length = 0;

fire('keydown', 'KeyJ', 9800);
fire('keyup', 'KeyJ', 9850);
check('轻按会发声', audio.played.filter((shot) => !/^boom/.test(shot.name)).length === 1, JSON.stringify(audio.played));
check('单发播放速率有抖动（不是死板的 1.0）', audio.played[0].rate !== 1, String(audio.played[0].rate));

// pickKind() 有 12% 的预抽（远处掠过 / 撞船），单发取样会误判，所以要打三下再看。
audio.played.length = 0;
for (let i = 0; i < 3; i += 1) {
  fire('keydown', 'KeyK', 9900 + i * 150);
  fire('keyup', 'KeyK', 10050 + i * 150);
}
check(
  '重按音色偏闷（炮击 / 撞船）',
  audio.played.some((shot) => /^(blast|wall|ram|long)/.test(shot.name)),
  JSON.stringify(audio.played.map((shot) => shot.name)),
);
check(
  '重击叠一发重炮层（strength ≥ 90）',
  audio.played.some((shot) => /^heavy/.test(shot.name)),
  JSON.stringify(audio.played.map((shot) => shot.name)),
);
check(
  '重炮层比单发慢（低频段、拉长）',
  audio.played.filter((shot) => /^heavy/.test(shot.name)).every((shot) => shot.rate < 0.9),
  JSON.stringify(audio.played.filter((shot) => /^heavy/.test(shot.name)).map((shot) => shot.rate)),
);

// 连打 → 手速过阈值 → 排一发远景爆炸（不自动续命，所以只会有一发待发）
for (let i = 0; i < 8; i += 1) {
  fire('keydown', 'KeyQ', 10600 + i * 60);
  fire('keyup', 'KeyQ', 10640 + i * 60);
}
env.flushTimeouts();
check(
  '连打之后放出一发远景',
  audio.played.some((shot) => /^far/.test(shot.name)),
  JSON.stringify(audio.played.map((shot) => shot.name)),
);

const sfxRange = collect(env.document.body, (node) => node.tagName === 'INPUT')[0];
const sfxValue = env.document.getElementById('dbf-sfx') && env.document.getElementById('dbf-sfx').childNodes[2];
sfxRange.value = '80';
sfxRange.listeners.input[0]();
env.flushTimeouts();
const diag = env.store.get('dsh-battlefield.sfxdiag.v1');
const diagObj = diag ? JSON.parse(diag) : {};
check(
  '自检记录写进 localStorage',
  diagObj.decoded >= 44 && diagObj.played >= 1 && diagObj.blocked === null,
  JSON.stringify(diagObj),
);

check('拖动音量条写进设置', JSON.parse(env.store.get('dsh-battlefield.sfx.v1')).volume === 0.8);
check('音量条旁边显示百分比', sfxValue.textContent === '80%', sfxValue.textContent);

// muted 是派生状态而不是持久开关：面板开着、也没暂停时，即使上一轮
// 残留了 muted（隔夜锁屏 / 宿主窗口被判成 hidden 留下的），也必须自愈。
const beforeMute = audio.played.length;
instance.sfx.setMuted(true);
fire('keydown', 'KeyL', 11100);
fire('keyup', 'KeyL', 11150);
check('残留静音自愈（隔夜没声音的那种）', audio.played.length > beforeMute, '没有自愈，仍被 muted 挡住');

// 真正的静音路径是收起面板：这时候一声都不许有。
const beforeCollapse = audio.played.length;
fire('keydown', 'KeyB', 11200, { key: 'b', shiftKey: true, metaKey: true });
check('收起面板算静音', root.getAttribute('data-hidden') === '1');
fire('keydown', 'KeyM', 11300);
fire('keyup', 'KeyM', 11350);
check('收起时一枪不发', audio.played.length === beforeCollapse, '多放了 ' + (audio.played.length - beforeCollapse) + ' 枪');
fire('keydown', 'KeyB', 11400, { key: 'b', shiftKey: true, metaKey: true });
fire('keydown', 'KeyN', 11500);
fire('keyup', 'KeyN', 11550);
check('展开后恢复开枪', audio.played.length > beforeCollapse);

// 连打 40 下：音色必须散开，否则又变成一串同样的鞭炮
audio.played.length = 0;
for (let i = 0; i < 40; i += 1) {
  env.clock.value = 12000 + i * 40;
  instance.sfx.fire(20 + Math.floor(((i * 37) % 75)));
}
{
  const kinds = new Set(audio.played.map((shot) => String(shot.name).replace(/-\d+$/, '')));
  check('连打时音色足够杂（≥ 4 种）', kinds.size >= 4, [...kinds].join(','));
  const booms = audio.played.filter((shot) => /^boom/.test(shot.name));
  check('连打时长尾层垫出低频轰鸣（这是「炮」和「鞭炮」的分水岭）', booms.length >= 3, '实际 ' + booms.length);
  check('长尾层都是长样本（≥ 1.2 秒）', booms.every((shot) => shot.duration >= 1.2), JSON.stringify(booms.map((shot) => shot.duration)));
  check('长尾层不抢主层（音高稳住，不被拉尖）', booms.every((shot) => shot.rate < 1.1), JSON.stringify(booms.map((shot) => shot.rate)));
check(
  '超过发声上限时被淘汰的声部是淡出的（不是一刀切断）',
  audio.cancelRamps > 0,
  'cancelRamps = ' + audio.cancelRamps,
);
}


const beforeModifier = audio.played.length;
fire('keydown', 'ShiftLeft', 12000);
fire('keyup', 'ShiftLeft', 12200);
check('修饰键不响（按住 ⇧ 两秒也不开枪）', audio.played.length === beforeModifier, '多放了 ' + (audio.played.length - beforeModifier) + ' 枪');

// 回车 = 电台应答，不是开火
{
  const beforeEnter = audio.played.length;
  env.clock.value = 14000;
  fire('keydown', 'Enter', 14000);
  fire('keyup', 'Enter', 14080);
  const fresh = audio.played.slice(beforeEnter);
  check('回车走电台应答（roger）', fresh.length === 1 && /roger/.test(fresh[0].name), JSON.stringify(fresh));
  check('回车不放炮击', !fresh.some((shot) => /^(blast|wall|ram)/.test(shot.name)), JSON.stringify(fresh));
  check('回车用平顶包络（不套枪声衰减）', fresh[0].envelope === 'flat', JSON.stringify(fresh[0]));
  check('回车播放完整长度（>0.8s）', fresh[0].duration > 0.8, String(fresh[0].duration));

  const beforeNumpad = audio.played.length;
  env.clock.value = 14300;
  fire('keydown', 'NumpadEnter', 14300);
  fire('keyup', 'NumpadEnter', 14380);
  const freshNumpad = audio.played.slice(beforeNumpad);
  check('小键盘回车同样走电台应答', freshNumpad.length === 1 && /roger/.test(freshNumpad[0].name), JSON.stringify(freshNumpad));

  const beforeLetter = audio.played.length;
  env.clock.value = 14600;
  fire('keydown', 'KeyJ', 14600);
  fire('keyup', 'KeyJ', 14680);
  const freshLetter = audio.played.slice(beforeLetter);
  check('普通键仍然开火（不是 roger）', freshLetter.length >= 1 && !/roger/.test(freshLetter[0].name), JSON.stringify(freshLetter));
  check('枪声仍用指数衰减包络', freshLetter[0].envelope === 'decay', JSON.stringify(freshLetter[0]));
}

/* ---- 氛围床：警报 → B-25 → 电台，整段连续播 ---- */

{
  // 先静音一次再恢复：把可能已经在跑的床停干净
  instance.sfx.setMuted(true);
  instance.sfx.setMuted(false);
  instance.sfx.setRng(() => 0);

  const info = instance.sfx.ambienceInfo();
  check('三条长录音已后台预热', info.siren === 1 && info.plane === 1 && info.radio === 1, JSON.stringify(info));

  const before = audio.played.length;
  env.clock.value = 200000;
  fire('keydown', 'KeyB', 200000);
  fire('keyup', 'KeyB', 200080);
  env.flushTimeouts();

  // 床是循环的，从哪一条开始取决于之前跑过几条 —— 只验证「三条都整段播过」
  const ambience = () => audio.played.slice(before).filter((x) => /siren|plane|radio/.test(x.name));
  const seen = new Map();
  for (let step = 0; step < 4 && seen.size < 3; step += 1) {
    for (const voice of ambience()) if (!seen.has(voice.name)) seen.set(voice.name, voice);
    env.flushTimeouts();
  }
  for (const voice of ambience()) if (!seen.has(voice.name)) seen.set(voice.name, voice);

  check('打字后氛围床开始连续播', seen.size >= 1, JSON.stringify([...seen.keys()]));
  check('三条录音都会被轮到（警报 → B-25 → 电台循环）', seen.size === 3, JSON.stringify([...seen.keys()]));

  const expect = { 'siren-1': 54.06, 'plane-1': 25.37, 'radio-1': 54.53 };
  for (const [name, duration] of Object.entries(expect)) {
    const voice = seen.get(name);
    check(name + ' 整段播完，不截断', voice && Math.abs(voice.window - duration) < 0.05, JSON.stringify(voice));
    check(name + ' 从头播（offset 0）', voice && voice.offset === 0, JSON.stringify(voice));
  }

  // 静音必须把床停掉：不再有新的氛围声部
  const beforeMute = audio.played.length;
  instance.sfx.setMuted(true);
  env.flushTimeouts();
  env.flushTimeouts();
  const afterMute = audio.played.slice(beforeMute).filter((x) => /siren|plane|radio/.test(x.name));
  check('静音后氛围床停止', afterMute.length === 0, JSON.stringify(afterMute.map((x) => x.name)));
  instance.sfx.setMuted(false);

  // 并发上限只淘汰短促的枪声：几十秒的氛围床不能被淡出掐断
  env.flushTimeouts();
  const stopsBefore = audio.stops.length;
  for (let i = 0; i < 40 && audio.stops.length === stopsBefore; i += 1) {
    const at = 260000 + i * 45;
    fire('keydown', 'KeyA', at);
    fire('keyup', 'KeyA', at + 20);
    env.clock.value = at + 21;
  }
  const fresh = audio.stops.slice(stopsBefore);
  check('并发压力下真的发生了声部淘汰', fresh.length > 0, '淘汰 ' + fresh.length);
  const longStops = fresh.filter((entry) => entry.duration >= 20);
  check('氛围床不会被并发上限淘汰', longStops.length === 0, JSON.stringify(longStops));
}

// 闲置 2.5 秒后挂起音频线程：不给硬件常驻供电
env.flushTimeouts();
check('闲置后 AudioContext 挂起', audio.suspended >= 1, '实际 ' + audio.suspended);

/* ---- 细调面板：滑块真的改到引擎里 ---- */

{
  const root = env.document.getElementById('dbf-root');
  const tuneBox = env.document.getElementById('dbf-tune');
  check('细调面板默认收起', root.getAttribute('data-tune') === '0' && !!tuneBox, String(root.getAttribute('data-tune')));
  const gear = collect(root, (node) => node.tagName === 'BUTTON' && node.textContent === '⚙')[0];
  check('标题栏有细调按钮', !!gear);
  gear.dispatch('click', { preventDefault() {}, stopPropagation() {} });
  check('点开细调面板', root.getAttribute('data-tune') === '1');

  const rows = tuneBox.childNodes.filter((node) => node.className === 'dbf-tune-row');
  check('细调面板渲染 8 行滑块', rows.length === 8, '实际 ' + rows.length);

  const findRow = (label) => rows.find((row) => row.childNodes[0].textContent === label);
  const tailRow = findRow('长尾');
  const tailRange = tailRow.childNodes[1];
  check('长尾滑块默认跟随「激烈」档 = 60%', tailRange.value === '60' && tailRow.getAttribute('data-custom') === '0', tailRange.value);

  // 长尾拉到 0：连打时不该再垫出 boom
  tailRange.value = '0';
  tailRange.dispatch('input');
  check('长尾拉到 0 生效', instance.sfx.tune().find((item) => item.key === 'tail').value === 0);
  check('手调过的行会标绿', tailRow.getAttribute('data-custom') === '1');
  const beforeTail = audio.played.length;
  for (let i = 0; i < 24; i += 1) {
    const at = 300000 + i * 60;
    fire('keydown', 'KeyB', at);
    fire('keyup', 'KeyB', at + 25);
    env.clock.value = at + 26;
  }
  const tailShots = audio.played.slice(beforeTail).filter((shot) => /^boom/.test(shot.name));
  check('长尾=0 时不再垫低频轰鸣', tailShots.length === 0, JSON.stringify(tailShots.map((shot) => shot.name)));

  // 主层长窗：0.24–0.32 秒的短切片有「啪」的拍手感，长窗（0.5–0.6 秒）才是「轰」。
  const longRow = findRow('主层长窗');
  const longRange = longRow.childNodes[1];
  check('主层长窗默认跟随「激烈」档 = 45%', longRange.value === '45' && longRow.getAttribute('data-custom') === '0', longRange.value);
  longRange.value = '100';
  longRange.dispatch('input');
  const beforeLong = audio.played.length;
  for (let i = 0; i < 4; i += 1) {
    const at = 310000 + i * 400;
    fire('keydown', 'KeyN', at);
    fire('keyup', 'KeyN', at + 140);
    env.clock.value = at + 141;
  }
  const longShots = audio.played.slice(beforeLong).filter((shot) => /^long/.test(shot.name));
  check('主层长窗=100% 时每下都用长样本', longShots.length >= 4, JSON.stringify(audio.played.slice(beforeLong).map((shot) => shot.name)));
  check('长样本确实更长（≥ 0.5 秒）', longShots.every((shot) => shot.duration >= 0.5), JSON.stringify(longShots.map((shot) => shot.duration)));
  longRange.value = '0';
  longRange.dispatch('input');
  const beforeShort = audio.played.length;
  for (let i = 0; i < 4; i += 1) {
    const at = 316000 + i * 400;
    fire('keydown', 'KeyM', at);
    fire('keyup', 'KeyM', at + 140);
    env.clock.value = at + 141;
  }
  check('主层长窗=0 时不再用长样本', audio.played.slice(beforeShort).filter((shot) => /^long/.test(shot.name)).length === 0);

  // 空间 = 0：混响送出归零，同时落盘
  const spaceRow = findRow('空间');
  spaceRow.childNodes[1].value = '0';
  spaceRow.childNodes[1].dispatch('input');
  check('空间拉到 0 时混响送出为 0', instance.sfx.chainInfo().space === 0, '实际 ' + instance.sfx.chainInfo().space);
  check('手调值写进 localStorage', JSON.parse(env.store.get('dsh-battlefield.tune.v1')).space === 0);

  // 间隔 = 0：10ms 内两下都发声
  const gapRow = findRow('间隔');
  gapRow.childNodes[1].value = '0';
  gapRow.childNodes[1].dispatch('input');
  const beforeGap = audio.played.length;
  const base = 320000;
  fire('keydown', 'KeyC', base);
  fire('keyup', 'KeyC', base + 5);
  env.clock.value = base + 6;
  fire('keydown', 'KeyC', base + 10);
  fire('keyup', 'KeyC', base + 15);
  check('间隔=0 时 10ms 内的两下都会发声', audio.played.length - beforeGap >= 2, '实际 ' + (audio.played.length - beforeGap));

  // 悬浮说明：鼠标挪到旋钮上就该解释这是干什么的
  const tip = env.document.getElementById('dbf-tip');
  check('面板里有悬浮说明节点', !!tip && tip.style.display !== 'block');
  tailRow.dispatch('mouseenter');
  check('悬停旋钮弹出说明', tip.style.display === 'block', tip.style.display);
  check('说明文字包含该旋钮的解释', tip.textContent.indexOf('低频') >= 0, tip.textContent.slice(0, 40));
  tailRow.dispatch('mouseleave');
  check('鼠标移开说明收起', tip.style.display === 'none', tip.style.display);
  tailRange.dispatch('focusin');
  check('键盘聚焦滑块也弹说明', tip.style.display === 'block');
  tailRange.dispatch('focusout');
  check('失焦后说明收起', tip.style.display === 'none');

  // 跟随档位：清空所有手调值  // 跟随档位：清空所有手调值
  const follow = tuneBox.childNodes[0].childNodes.find((node) => node.tagName === 'BUTTON');
  follow.dispatch('click', { preventDefault() {}, stopPropagation() {} });
  check('跟随档位把长尾恢复成 60%', instance.sfx.tune().find((item) => item.key === 'tail').value === 60);
  check('跟随档位把空间恢复成 100%', instance.sfx.chainInfo().space === 100);
  check('跟随档位后滑块也刷新', findRow('长尾').childNodes[1].value === '60');
  check('跟随档位把覆盖值从存储里清掉', Object.keys(JSON.parse(env.store.get('dsh-battlefield.tune.v1'))).length === 0);
}

instance.dispose();
check('卸载时关闭 AudioContext', audio.closed === 1, '实际 ' + audio.closed);

/* ---- 界面语言跟随 DSH 设置 ---- */

let localeActive = 'zh';
const localeWatchers = [];
const localeCtx = {
  locale: {
    getLocale: () => ({ active: localeActive, locales: ['zh', 'en'], revision: 1 }),
    subscribe(fn) {
      localeWatchers.push(fn);
      return () => {
        const at = localeWatchers.indexOf(fn);
        if (at >= 0) localeWatchers.splice(at, 1);
      };
    },
  },
};

const tuneRowNamed = (label) =>
  collect(
    env.document.body,
    (node) =>
      node.className === 'dbf-tune-row' &&
      node.childNodes[0] !== undefined &&
      node.childNodes[0].textContent === label,
  )[0];

localeActive = 'en';
const disposeI18n = pluginModule.apply(localeCtx);
const i18nInstance = env.window.__DSH_BATTLEFIELD__;
check('订阅了语言切换', localeWatchers.length === 1, '实际 ' + localeWatchers.length);
check(
  'DSH 是英文时面板出英文',
  collect(env.document.body, (node) => node.textContent === 'keystrokes').length === 1,
  '没找到 keystrokes',
);
check('英文下细调项也是英文', tuneRowNamed('Space') !== undefined, '没找到 Space 行');

fire('keydown', 'KeyP', 21000);
fire('keyup', 'KeyP', 21080);
fire('keydown', 'KeyO', 21100);
fire('keyup', 'KeyO', 21180);
const beforeSwitch = i18nInstance.engine.snapshot(21180).total;
check('切语言之前有 2 击', beforeSwitch === 2, '实际 ' + beforeSwitch);

localeActive = 'zh';
localeWatchers[0]();
check('语言切回中文后文案跟着换', collect(env.document.body, (node) => node.textContent === '有效击键').length === 1);
check('切语言之后细调项回到中文', tuneRowNamed('长尾') !== undefined, '没找到 长尾 行');
const afterSwitch = env.window.__DSH_BATTLEFIELD__.engine.snapshot(21200).total;
check('切语言不丢统计（同一个 engine）', afterSwitch === beforeSwitch, '实际 ' + afterSwitch);
check('切语言不叠第二个面板', collect(env.document.body, (node) => node.id === 'dbf-root').length === 1);

disposeI18n();
check('卸载时退订语言切换', localeWatchers.length === 0, '残留 ' + localeWatchers.length);
check('卸载后 dbf-root 移除', env.document.getElementById('dbf-root') === null);


const revived = pluginModule.apply();
check('重新 apply 仍只有一个实例', collect(env.document.body, (node) => node.id === 'dbf-root').length === 1);
void revived;
revived();
check('枪声开关跨重载保留（localStorage）', JSON.parse(env.store.get('dsh-battlefield.sfx.v1')).enabled === true);

/* ---- 热更幂等 ---- */

const secondDispose = pluginModule.apply();
check('再次 apply 不叠加实例', collect(env.document.body, (node) => node.id === 'dbf-root').length === 1);
check('再次 apply 返回可用的 dispose', typeof secondDispose === 'function');
secondDispose();

/* ---- 卸载 ---- */

const disposeThird = pluginModule.apply();
const beforeDispose = env.window.listenerCount('keydown');
check('卸载前 window 上有 keydown 监听', beforeDispose > 0, '实际 ' + beforeDispose);
disposeThird();
check('卸载后 window 上的 keydown 监听全部撤掉', env.window.listenerCount('keydown') === 0, '残留 ' + env.window.listenerCount('keydown'));
check('卸载后 dbf-root 从 DOM 移除', env.document.getElementById('dbf-root') === null);
check('卸载后 pill 从 DOM 移除', env.document.getElementById('dbf-pill') === null);
check('卸载后 style 节点也移除', env.document.getElementById('dbf-style') === null);
check('卸载后全局实例句柄清除', env.window.__DSH_BATTLEFIELD__ === undefined);

/* ---- 报告 ---- */

const warnings = env.logs.filter((entry) => entry[0] === 'warn' || entry[0] === 'error');
check('运行过程中没有 warn/error', warnings.length === 0, JSON.stringify(warnings.slice(0, 3)));

if (failures.length > 0) {
  console.error('\n✗ dsh-battlefield smoke: ' + failures.length + ' 项失败\n');
  for (const failure of failures) console.error('  · ' + failure);
  process.exit(1);
}

console.log('✓ dsh-battlefield smoke: ' + passed + ' 项全部通过');
