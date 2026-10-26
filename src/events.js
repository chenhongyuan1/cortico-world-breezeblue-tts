/**
 * 事件库读取层：找当前 run、盯着 events.jsonl、把新行解析成一条条要念的文本。
 *
 * 数据布局（Coopanion 0.2.1 实测）：
 *   <部署目录>/data/runs/index.jsonl          每次开机一行，最后一行属于最近一次 run
 *   <部署目录>/data/runs/<run>/events.jsonl   一行一个 JSON 事件（追加写）
 * 部署目录一般是 <安装目录>\data\home\companion（CORTICO_HOME/co <bot 名>）。
 *
 * 要的文字在桌宠自己记的 desktop-pet.self 事件里：
 *   {"type":"desktop-pet.self","text":"…","meta":{"kind":"say","beats":[{"text":"…"}]},…}
 * meta.kind 为 say 时 beats[].text 就是逐段显示在气泡里的原文（表情/动作标记已被桌宠剥掉）；
 * 为 ask 时 question / options 是提问气泡的文字。这类事件带 contextDelivery:"archive-only"，
 * 只入库、从不送给 bot，所以它是"气泡显示过什么"最贴近的一份记录。
 *
 * 为什么读文件而不是订阅：0.2.1 的 World 接口只让自己发事件（WorldHost.pushEvent），没有
 * "订阅别的 World 的工具调用/事件"的钩子；persona.onDelivery 也收不到 archive-only 的事件。
 * 文件是最稳、跨版本风险最小的接口。见 README「依赖的契约」。
 */
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanScript, truncate } from './text.js';
import { TEXT_MAX } from './config.js';

const RUNS_DIRNAME = 'runs';
const EVENTS_FILENAME = 'events.jsonl';
const SELF_TYPE = 'desktop-pet.self';

/** 认不出的行、非 say 的事件都跳过；坏行不该打断朗读。 */
function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * 把一条事件变成要念的文本。返回 '' 表示这条不该念。
 *
 * kind=say：beats[].text 逐段，用句号那样的停顿感交给队列（每段单独念）。
 * kind=ask：问句 + 选项（选项连起来念一遍，方便不开屏幕也听得见在问什么）。
 */
export function spokenTextsOf(event) {
  if (!event || typeof event !== 'object') return [];
  if (event.type !== SELF_TYPE) return [];
  const meta = event.meta;
  if (!meta || typeof meta !== 'object') return [];
  if (meta.kind === 'say') {
    const beats = Array.isArray(meta.beats) ? meta.beats : [];
    const out = beats
      .map((b) => (b && typeof b.text === 'string' ? cleanScript(b.text) : ''))
      .filter(Boolean);
    if (out.length) return out;
    // 没有 beats 时退回事件自己的 text（老版本或形状变化时的兜底）
    const fallback = cleanScript(event.text);
    return fallback ? [fallback] : [];
  }
  if (meta.kind === 'ask') {
    const question = cleanScript(meta.question);
    if (!question) return [];
    const options = Array.isArray(meta.options)
      ? meta.options.filter((o) => typeof o === 'string' && o.trim()).map((o) => o.trim())
      : [];
    return [options.length ? `${question} 选项：${options.join('，')}` : question];
  }
  return [];
}

/** 部署目录里当前 run 的 id：index.jsonl 最后一行里带 startedAt 的那条。 */
export function currentRunId(dataDir) {
  const index = join(dataDir, RUNS_DIRNAME, 'index.jsonl');
  if (!existsSync(index)) return null;
  let text;
  try {
    text = readFileSync(index, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const row = safeJson(lines[i]);
    if (row && typeof row.run === 'string' && row.startedAt) return row.run;
  }
  return null;
}

/** 当前 run 的 events.jsonl 绝对路径；找不到回 null。 */
export function currentEventsFile(dataDir) {
  const run = currentRunId(dataDir);
  if (!run) return null;
  const file = join(dataDir, RUNS_DIRNAME, run, EVENTS_FILENAME);
  return existsSync(file) ? file : null;
}

/**
 * 盯住 events.jsonl。
 *
 * 三个都要处理的现实情况：
 *   - 文件是追加写的，所以记住读到哪个字节，只处理新内容；
 *   - 一行可能只写了一半，所以留残行，等下一次读到再拼；
 *   - Coopanion 重启会换 run（换文件、还可能换目录），所以定时复查当前 run 是否变了，
 *     变了就从头读新文件（并把已读过的游标集合清掉）。
 *
 * 只读、不写、不锁文件；读失败时下次再试，不会因为一次 EPERM/EBUSY 就停掉。
 */
export function createEventWatcher({
  dataDir,
  onText,
  onLog = () => {},
  pollMs = 500,
  /** 启动时是否从头念一遍已有事件（默认否：只念开始之后新出现的）。 */
  replayExisting = false,
  /** 同一游标只念一次，用最近见过的一小段集合去重。 */
  seenLimit = 256,
} = {}) {
  const seen = new Set();
  const seenOrder = [];
  let file = null;
  let offset = 0;
  let carry = '';
  let reading = false;
  let timer = null;
  let stopped = false;

  const remember = (key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    seenOrder.push(key);
    while (seenOrder.length > seenLimit) seen.delete(seenOrder.shift());
    return true;
  };

  const emit = (event) => {
    // 游标只在同一个 run 内唯一，所以去重键必须带上 run：换 run 后新 run 的 cursor=2
    // 不能被上一个 run 的 cursor=2 顶掉（这是测试逼出来的一个真 bug）。
    const key = typeof event.cursor === 'number'
      ? `${typeof event.run === 'string' ? event.run : '?'}#${event.cursor}`
      : null;
    if (key && !remember(key)) return;
    for (const text of spokenTextsOf(event)) {
      const line = truncate(text, TEXT_MAX);
      if (line) onText(line, event);
    }
  };

  /** 读完 [offset, EOF)。文件被截断/换掉时从头读。 */
  function readMore() {
    return new Promise((resolveRead) => {
      let size;
      try {
        size = statSync(file).size;
      } catch {
        resolveRead();
        return;
      }
      if (size < offset) {
        // 文件变小：被截断或换了同名文件，从头来
        offset = 0;
        carry = '';
      }
      if (size === offset) {
        resolveRead();
        return;
      }
      const stream = createReadStream(file, { start: offset, end: size - 1, encoding: 'utf8' });
      let chunk = '';
      stream.on('data', (d) => { chunk += d; });
      stream.on('error', (err) => {
        onLog('warn', `读 events.jsonl 失败：${err.message}`);
        resolveRead();
      });
      stream.on('end', () => {
        offset = size;
        const text = carry + chunk;
        const lines = text.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = safeJson(line);
          if (event) emit(event);
        }
        resolveRead();
      });
    });
  }

  async function tick() {
    if (stopped || reading) return;
    reading = true;
    try {
      const next = currentEventsFile(dataDir);
      if (!next) {
        if (file) onLog('warn', '当前 run 的 events.jsonl 不见了，等它出现');
        file = null;
        return;
      }
      if (next !== file) {
        file = next;
        offset = 0;
        carry = '';
        // 换文件就是把 run 也换了：上一轮的游标记录对新 run 没有意义，清掉。
        seen.clear();
        seenOrder.length = 0;
        if (!replayExisting) {
          try {
            offset = statSync(file).size;
          } catch {
            offset = 0;
          }
        }
        onLog('info', `开始盯 ${file}${replayExisting ? '（含已有事件）' : '（只念之后新出现的）'}`);
      }
      await readMore();
    } finally {
      reading = false;
    }
  }

  return {
    /** 立刻读一次（启动时用），并把定时器挂上。 */
    async start() {
      await tick();
      timer = setInterval(() => { void tick(); }, pollMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** 自检与面板用：现在在读哪个文件、读到哪了。 */
    state: () => ({ file, offset, carry: carry.length, seen: seen.size }),
    /** 立刻读一次（面板上的"重读"用）。 */
    poll: tick,
  };
}

/**
 * 找"数据目录"——也就是直接含 runs/ 的那一层（events.jsonl 在 runs/<run>/ 下）。
 *
 * 在 Coopanion 里运行时用不到这些猜测：框架把 ctx.dataDir（就是它）直接给了 World。
 * 这个函数主要给独立自检、以及在配置里留空时兜底。
 *
 * 目录层次（Coopanion 0.2.1 实测）：
 *   部署目录（含 config.json / deployment.json）
 *     ├─ data/            ← paths.data，里面是 runs/、session-main.jsonl
 *     └─ workspace/       ← paths.memory
 *
 * 所以既能吃"部署目录"，也能吃"数据目录"，两种都给对。
 */
/** 直接含 runs/ 的目录就是数据目录。 */
const hasRuns = (dir) => Boolean(dir) && existsSync(join(dir, RUNS_DIRNAME));

/** 一个候选目录下的数据目录：它自己、它的 data/，或它下面 home/<bot>/。 */
function dataDirUnder(dir) {
  if (!dir || !existsSync(dir)) return null;
  if (hasRuns(dir)) return dir;
  if (hasRuns(join(dir, 'data'))) return join(dir, 'data');
  const home = join(dir, 'home');
  if (existsSync(home)) {
    try {
      for (const entry of readdirSync(home, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const bot = join(home, entry.name);
        if (hasRuns(bot)) return bot;
        if (hasRuns(join(bot, 'data'))) return join(bot, 'data');
      }
    } catch { /* 读不到就算了 */ }
  }
  return null;
}

export function resolveDataDir(explicit, env = process.env) {
  const tried = [];
  const attempt = (dir) => {
    if (!dir) return null;
    tried.push(dir);
    return dataDirUnder(dir);
  };

  let hit = attempt(explicit);
  if (hit) return hit;
  hit = attempt(env.CORTICO_HOME);
  if (hit) return hit;
  hit = attempt(env.CORTICO_COMPANION_DATA);
  if (hit) return hit;

  // 程序目录旁的 data：Coopanion 在 Windows 上默认把数据放在可执行文件所在目录。
  const appRoot = env.CORTICO_APP_ROOT
    || (typeof process.execPath === 'string' ? resolve(process.execPath, '..') : '');
  hit = attempt(appRoot ? join(appRoot, 'data') : null);
  if (hit) return hit;

  // 常见安装位置
  const roots = [];
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA;
    const roaming = env.APPDATA;
    if (local) {
      roots.push(join(local, 'Programs', 'Coopanion', 'data'));
      roots.push(join(local, 'Coopanion'));
    }
    if (roaming) roots.push(join(roaming, 'Coopanion'));
    for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
      if (env[key]) roots.push(join(env[key], 'Coopanion', 'data'));
    }
  } else if (process.platform === 'darwin') {
    roots.push(join(env.HOME ?? '', 'Library', 'Application Support', 'Coopanion'));
  } else {
    roots.push(join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? '', '.config'), 'Coopanion'));
    roots.push(join(env.HOME ?? '', '.config', 'Coopanion'));
  }
  for (const root of roots) {
    hit = attempt(root);
    if (hit) return hit;
  }

  // 实在找不到：把最可能的一个给出去，让调用方把路径报出来给人看
  return tried[0] ?? null;
}
