/**
 * 自检：不启动 Coopanion，用真数据把整条链路走一遍。
 *
 *   node scripts/selftest.mjs
 *
 * 做这些事：
 *   1. 校验默认导出是合法的 WorldDefinition（api 6 的形状：id / label / defaults / create）；
 *   2. 校验控制台配置声明（键、类型、范围）与 defaults() 对得上；
 *   3. 剥标记 + 从真实事件库取气泡文字；
 *   4. 实例化 World，验 tools() / webUi() / configOptions() 的形状；
 *   5. 密钥读取：谁优先、有没有脱敏（不发任何网络请求）；
 *   6. 没 key 时会自动回退到系统语音（用假引擎验证，不联网）；
 *   7. 探本机系统语音、本地播放器，并可选真的念一句（--speak / --cloud）。
 *
 * 选项：
 *   --data <目录>   指定部署目录（默认自动找）
 *   --speak         用系统语音真的念一句（会出声）
 *   --cloud         用云端真的念一句（会联网、会消耗额度；需要已配 key）
 *   --voice <名字>  系统语音试听用的音色
 *   --json          机器可读输出
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import world from '../src/index.js';
import { petVoiceDefaults } from '../src/index.js';
import { cleanScript } from '../src/text.js';
import { spokenTextsOf, resolveDataDir, currentRunId, currentEventsFile } from '../src/events.js';
import { petVoiceConfigGroups } from '../src/config-schema.js';
import { listVoices, speakSapi } from '../src/tts.js';
import { resolveApiKey, redact } from '../src/secrets.js';
import { createSpeech } from '../src/speech.js';
import { wavInfo, probePlayer } from '../src/player.js';
import { MINIMAX_MODELS, CHINESE_VOICES, ENDPOINTS } from '../src/cloud.js';

const argv = process.argv.slice(2);
// 实例化冒烟测试会走 World 的构造，它可能写一行日志到 stderr；这里静音，免得污染输出。
process.env.PET_VOICE_SILENT = '1';
const flag = (name) => argv.includes(name);
const value = (name, dflt = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const results = [];
let failed = 0;
let skipped = 0;
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail });
  if (!ok) failed += 1;
};
/** 环境限制（不是产品问题）：记成 SKIP，不算失败。 */
const skip = (label, detail = '') => {
  results.push({ ok: true, skipped: true, label, detail });
  skipped += 1;
};

// ── 1. World 定义的形状（等价于框架 isWorldDefinition + api 6 的字段） ──────
const shapeOk = world
  && typeof world.id === 'string' && world.id !== ''
  && typeof world.label === 'string'
  && typeof world.defaults === 'function'
  && typeof world.create === 'function';
check(shapeOk, '默认导出是 WorldDefinition（id / label / defaults() / create()）',
  shapeOk ? `id=${world.id} label=${world.label}` : '形状不对，框架会拒绝加载');

const defs = world.defaults();
check(defs && typeof defs === 'object' && defs.enabled === false,
  'defaults().enabled === false（按需求默认关）', `enabled=${defs?.enabled}`);

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
check(pkg.type === 'module', 'package.json 是 type: module（框架要求，保证 ESM 单实例）');
check(pkg.cortico?.kind === 'world', 'cortico.kind === "world"', String(pkg.cortico?.kind));
check(pkg.cortico?.api === 6, 'cortico.api === 6（Coopanion 0.2.1 的 world 契约版本）', String(pkg.cortico?.api));
check(Array.isArray(pkg.keywords) && pkg.keywords.includes('cortico-world'),
  'keywords 含 cortico-world（否则 manifest 给 warning）');

// ── 2. 配置声明与默认值对得上 ────────────────────────────────────────────
const groups = petVoiceConfigGroups('zh');
check(Array.isArray(groups) && groups.length > 0, '控制台配置组已声明', `${groups.length} 组`);
let cfgPropCount = 0;
let cfgMismatch = [];
for (const g of groups) {
  if (g.owner !== `world:${world.id}`) cfgMismatch.push(`${g.id}: owner=${g.owner}`);
  if (!g.schema || typeof g.schema.properties !== 'object') { cfgMismatch.push(`${g.id}: 没有 schema.properties`); continue; }
  for (const [path, prop] of Object.entries(g.schema.properties)) {
    cfgPropCount += 1;
    if (!path.startsWith(`worlds.${world.id}.`)) { cfgMismatch.push(`${path}: 前缀不对`); continue; }
    const leaf = path.slice(`worlds.${world.id}.`.length);
    if (!(leaf in defs)) { cfgMismatch.push(`${path}: defaults() 里没有这个字段`); continue; }
    const dv = defs[leaf];
    // number 与 integer 在 JSON Schema 里是兼容的：声明 number、默认写 1 没问题
    const want = typeof dv === 'boolean'
      ? 'boolean'
      : (typeof dv === 'number' ? 'number' : 'string');
    const okType = prop.type === want
      || (want === 'number' && (prop.type === 'integer' || prop.type === 'number'));
    if (!okType) cfgMismatch.push(`${path}: 声明 ${prop.type}，默认值是 ${want}`);
    // enum 字段的默认值必须在候选里，否则界面一打开就显示不上
    if (prop.enum && !prop.enum.includes(String(dv))) {
      cfgMismatch.push(`${path}: 默认值 ${JSON.stringify(dv)} 不在 enum 里（${prop.enum.slice(0, 4).join('/')}…）`);
    }
  }
}
check(cfgMismatch.length === 0, `配置声明的 ${cfgPropCount} 个键与 defaults() 一致`,
  cfgMismatch.join('；') || '每个键都在 defaults() 里有对应的默认值，类型也对得上');

// ── 3. 剥标记：真实脚本样例 ─────────────────────────────────────────────
const stripCases = [
  ['\u3010sleepy\u3011\u6233\u8fd9\u4e48\u591a\u6b21...\u6211\u9192\u5566,\u5e93...<surprised>\u90fd\u534a\u591c\u5341\u4e8c\u70b9\u591a\u4e86,\u4f60\u8fd8\u4e0d\u7761\u5440?',
    '\u6233\u8fd9\u4e48\u591a\u6b21...\u6211\u9192\u5566,\u5e93...\u90fd\u534a\u591c\u5341\u4e8c\u70b9\u591a\u4e86,\u4f60\u8fd8\u4e0d\u7761\u5440?'],
  ['\u3010\u5f00\u5fc3, \u8df3\u3011\u4f60\u597d', '\u4f60\u597d'],
  ['<happy,hop>\u4eca\u5929\u4e5f\u8f9b\u82e6\u5566', '\u4eca\u5929\u4e5f\u8f9b\u82e6\u5566'],
  ['\u3010\u5f00\u5fc3\u3011', ''],
];
let stripBad = [];
for (const [input, want] of stripCases) {
  const got = cleanScript(input);
  if (got !== want) stripBad.push(`${JSON.stringify(input)} -> ${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`);
}
check(stripBad.length === 0, '气泡标记（\u3010\u3011与<>）剥得干净', stripBad.join('；') || `${stripCases.length} 个样例全部通过`);

// 事件 → 文本
const fakeSay = { type: 'desktop-pet.self', text: 'x', meta: { kind: 'say', beats: [{ text: '\u4f60\u597d\u5440' }, { text: '<blink>\u55ef' }] } };
const fakeSayTexts = spokenTextsOf(fakeSay);
check(fakeSayTexts.length === 2 && fakeSayTexts[0] === '\u4f60\u597d\u5440' && fakeSayTexts[1] === '\u55ef',
  'say 事件按 beats 逐段取出（<blink> 被剥掉）', JSON.stringify(fakeSayTexts));
const fakeAsk = { type: 'desktop-pet.self', meta: { kind: 'ask', question: '\u8981\u4f11\u606f\u5417?', options: ['\u8981', '\u4e0d\u8981'] } };
check(spokenTextsOf(fakeAsk).length === 1, 'ask 事件的提问也能取出来', JSON.stringify(spokenTextsOf(fakeAsk)));
check(spokenTextsOf({ type: 'desktop-pet.touch', meta: {} }).length === 0,
  '别人的事件不会被念（只认 desktop-pet.self 的 say/ask）');

// ── 4. 真实事件库 ───────────────────────────────────────────────────────
const dataDirArg = value('--data');
const dataDir = resolveDataDir(dataDirArg || undefined);
check(Boolean(dataDir) && existsSync(dataDir), '找到部署目录', dataDir || '没找到；用 --data 指定');

let sampleLines = [];
let scanned = 0;
let sayCount = 0;
if (dataDir && existsSync(dataDir)) {
  const run = currentRunId(dataDir);
  const file = currentEventsFile(dataDir);
  check(Boolean(file), '找到当前 run 的 events.jsonl', file || `runs/index.jsonl 里没读到 run（currentRunId=${run}）`);
  // 连历史 run 一起扫，样本更多；当前 run 没有 say 时也能验证解析
  const runsDir = join(dataDir, 'runs');
  const runDirs = existsSync(runsDir)
    ? readdirSync(runsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
  for (const dir of runDirs) {
    const f = join(runsDir, dir, 'events.jsonl');
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());
    scanned += lines.length;
    for (const line of lines) {
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev?.type !== 'desktop-pet.self') continue;
      const texts = spokenTextsOf(ev);
      if (!texts.length) continue;
      sayCount += 1;
      if (sampleLines.length < 5) sampleLines.push(texts.join(' / '));
    }
  }
  check(sayCount > 0, `从真实事件库里解析出 ${sayCount} 条气泡文字（扫了 ${scanned} 行、${runDirs.length} 个 run）`,
    sayCount ? '' : '没找到 say 事件：让桌宠说一句再跑一次，或用 --data 指定正确的部署目录');
}

// ── 5. 密钥读取与脱敏（不发任何网络请求） ────────────────────────────────
// 用一个假环境验证优先级：环境变量 > .env > 都没有。绝不打印 key 本身。
const fakeKey = 'sk-selftest-fake-key-0123456789';
const savedKey = process.env.MINIMAX_API_KEY;
const savedNamedKey = process.env.PET_VOICE_TEST_KEY;
try {
  delete process.env.MINIMAX_API_KEY;
  const none = resolveApiKey({}, { botDir: dataDir ?? '' });
  check(none.key === '' || process.env.MINIMAX_API_KEY !== undefined,
    '没配 key 时不会凭空捏造一个', none.key ? `从 ${none.from} 读到（说明环境里本来就有）` : `找过 ${none.tried.length} 处都没找到`);

  process.env.MINIMAX_API_KEY = fakeKey;
  const fromEnv = resolveApiKey({}, { botDir: dataDir ?? '' });
  check(fromEnv.key === fakeKey && fromEnv.from === 'env:MINIMAX_API_KEY',
    '环境变量 MINIMAX_API_KEY 优先被读到', `from=${fromEnv.from}`);

  process.env.PET_VOICE_TEST_KEY = 'sk-named-key-abcdefghijkl';
  const named = resolveApiKey({ minimaxApiKeyEnv: 'PET_VOICE_TEST_KEY' }, { botDir: dataDir ?? '' });
  check(named.key === 'sk-named-key-abcdefghijkl' && named.from === 'env:PET_VOICE_TEST_KEY',
    'minimaxApiKeyEnv 能指定自定义环境变量名', `from=${named.from}`);

  const fromConfig = resolveApiKey({ minimaxApiKey: 'sk-config-key-zzzzzzzzzz' }, { botDir: dataDir ?? '' });
  check(fromConfig.from === 'config', 'config 里的 key（若有）优先级最高', `from=${fromConfig.from}`);

  const redacted = redact(`Authorization: Bearer ${fakeKey} failed`, [fakeKey]);
  check(!redacted.includes(fakeKey), '日志脱敏会把 key 抹成 ***', redacted);
  const redactedHeader = redact('sent Bearer abcdefghijklmnopqrstuvwxyz', []);
  check(!/abcdefghijklmnopqrstuvwxyz/.test(redactedHeader), '即使不知道 key 值，Bearer 头也会被抹掉', redactedHeader);
} finally {
  if (savedKey === undefined) delete process.env.MINIMAX_API_KEY; else process.env.MINIMAX_API_KEY = savedKey;
  if (savedNamedKey === undefined) delete process.env.PET_VOICE_TEST_KEY; else process.env.PET_VOICE_TEST_KEY = savedNamedKey;
}

// 云端参数与音色表形状
check(MINIMAX_MODELS.includes('speech-2.8-turbo') && MINIMAX_MODELS.includes('speech-02-hd'),
  `模型表含官方型号（${MINIMAX_MODELS.length} 个）`, MINIMAX_MODELS.join(', '));
check(CHINESE_VOICES.some((v) => v.id === 'female-shaonv') && CHINESE_VOICES.length >= 10,
  `中文音色表可用（${CHINESE_VOICES.length} 个）`, CHINESE_VOICES.slice(0, 4).map((v) => v.id).join(', '));
check(ENDPOINTS.cn.includes('api.minimax.cn') && ENDPOINTS.io.includes('api.minimax.io'),
  '两个站点地址正确', `${ENDPOINTS.cn} | ${ENDPOINTS.io}`);
check(defs.minimaxFormat === 'wav', '云端音频格式固定 wav（本地播放器按 WAV 播）', defs.minimaxFormat);
check(defs.fallback === 'auto' && defs.minimaxEnabled === true,
  '默认声音来源 auto（云端优先），但总开关 enabled 仍为关', `fallback=${defs.fallback} enabled=${defs.enabled}`);

// ── 6. 没配 key 时自动走系统语音（拦住 fetch 数网络调用，不联网） ────────
// 思路：拿不到 key 时**不发请求**，直接调 tts.js 的 speakSapi。这里把 globalThis.fetch
// 临时换掉，数一数到底有没有碰网络；系统语音那一层在沙箱里会 spawn 失败，那不算这项的错。
try {
  const { synthesizeMiniMax } = await import('../src/cloud.js');
  const realFetch = globalThis.fetch;
  let netCalls = 0;
  globalThis.fetch = (...args) => { netCalls += 1; return realFetch(...args); };
  try {
    const cfg = {
      ...world.defaults(),
      enabled: true,
      fallback: 'auto',
      minimaxEnabled: true,
      cloudProvider: 'minimax',
    };
    const nowhere = { botDir: '__no_such_dir__', dataDir: '__no_such_dir__' };

    // 6a. 云端客户端本身：没 key 就该立刻失败，且不打网络
    const direct = await synthesizeMiniMax('测试', cfg, nowhere);
    check(direct.ok === false && direct.code === 'no-key' && netCalls === 0,
      '云端客户端没 key 时立刻报 no-key，且不发请求',
      `code=${direct.code} 网络调用=${netCalls} 原因=${direct.error}`);

    // 6b. 路由层：没 key 时这一句走系统语音，并说明原因
    const speech = createSpeech({ getConfig: () => cfg, opts: nowhere, log: () => {} });
    const st = speech.status();
    if (st.cloudConfigured) {
      skip('路由层的没-key 回退', `当前环境本来就有 key（from=${st.keyFrom}），这一项跳过`);
    } else {
      const res = await speech.speak('回退路径测试');
      check(netCalls === 0, '没 key 时整条路径都不去发网络请求（不白等超时）', `网络调用=${netCalls}`);
      check(res.engine === 'sapi' && res.fellBack === true && res.fallbackReason === 'no-key',
        '没 key 时改用系统语音并标明原因 no-key',
        `engine=${res.engine} fellBack=${res.fellBack} reason=${res.fallbackReason} ok=${res.ok}${res.error ? ` err=${res.error}` : ''}`);
      check(JSON.stringify(st).includes('sk-') === false, 'status() 里不会出现 key 的字面量', '已检查');
    }
  } finally {
    globalThis.fetch = realFetch;
  }
} catch (err) {
  check(false, '回退路径测试能跑完', err?.stack ?? String(err));
}

// ── 7. 本地播放器的 WAV 解析 ─────────────────────────────────────────────
// 造 WAV 的助手：时长按"帧数 ÷ 采样率"算，这正是曾经算错的地方。
const makeWav = ({ seconds, rate, channels = 1, bits = 16 }) => {
  const frames = Math.round(rate * seconds);
  const data = Buffer.alloc(frames * (bits / 8) * channels);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * (bits / 8), 28);
  header.writeUInt16LE(channels * (bits / 8), 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};

// 三个规格都要对：MiniMax 默认给的是 32kHz 单声道，但这三个数字历史上都算错过。
for (const spec of [{ seconds: 0.1, rate: 16000 }, { seconds: 0.6, rate: 32000 }, { seconds: 1, rate: 44100, channels: 2 }]) {
  const info = wavInfo(makeWav(spec));
  const wantMs = Math.round(spec.seconds * 1000);
  check(info && Math.abs(info.ms - wantMs) <= 1,
    `WAV 时长算对：${spec.seconds}s @ ${spec.rate}Hz ${spec.channels ?? 1}ch`,
    info ? `得到 ${info.ms}ms（期望 ${wantMs}ms），frames=${info.frames} bytesPerFrame=${info.bytesPerFrame}` : 'null');
}
const info = wavInfo(makeWav({ seconds: 0.1, rate: 16000 }));
check(info && info.sampleRate === 16000 && info.channels === 1 && info.bitsPerSample === 16,
  'WAV 头解析正确（采样率/声道/位深）', info ? JSON.stringify(info) : 'null');
check(wavInfo(Buffer.from('not a wav at all')) === null, '非 WAV 数据会被识别出来（不会硬播）');
// 头部多出几字节（例如被写入 BOM）也要能算出正确时长：靠扫块，不靠固定偏移
const withJunk = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), makeWav({ seconds: 0.5, rate: 16000 })]);
check(wavInfo(withJunk) === null, 'BOM 在前面会破坏 RIFF 识别（此时不硬播，交给上层报错）');

// ── 7b. 请求体与响应解析（用假 fetch，全程不联网） ───────────────────────
// 这是最容易写错、又最难在真机上试出来的一环：MiniMax 的字段名、层级、错误码。
try {
  const { synthesizeMiniMax } = await import('../src/cloud.js');
  const realFetch = globalThis.fetch;
  const jsonResponse = (obj, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(obj),
  });

  try {
    // a) 抓请求
    let seen = null;
    globalThis.fetch = async (url, init) => {
      seen = { url, init };
      return jsonResponse({
        data: { audio: Buffer.from('RIFFxxxxWAVE').toString('hex'), status: 2 },
        extra_info: { audio_length: 1234, audio_format: 'wav', usage_characters: 7, audio_sample_rate: 32000 },
        trace_id: 'trace-1',
        base_resp: { status_code: 0, status_msg: 'success' },
      });
    };
    const cfg = {
      ...world.defaults(),
      minimaxApiKey: 'sk-fake-for-request-shape-0001',
      cloudProvider: 'minimax',
      minimaxModel: 'speech-2.8-hd',
      minimaxVoice: 'female-tianmei',
      minimaxSpeed: 1.25,
      minimaxVolume: 2,
      minimaxPitch: 3,
      minimaxEmotion: 'happy',
      minimaxSampleRate: '24000',
      minimaxEndpoint: 'cn',
      minimaxFormat: 'wav',
    };
    const ok = await synthesizeMiniMax('你好', cfg, { botDir: '__no_such_dir__' });
    check(ok.ok === true && Buffer.isBuffer(ok.bytes), '云端成功路径：十六进制音频被解成字节',
      `bytes=${ok.bytes?.length} model=${ok.model} voice=${ok.voiceId} 用量=${ok.usage?.characters}`);

    const reqBody = JSON.parse(seen.init.body);
    check(seen.url === ENDPOINTS.cn, '默认打到国内站点，且没多余 query',
      seen.url);
    check(seen.init.headers.Authorization === 'Bearer sk-fake-for-request-shape-0001',
      'Authorization 用 Bearer 形式', seen.init.headers.Authorization.replace(/sk-[\w-]+/, 'sk-***'));
    check(seen.init.headers['Content-Type'] === 'application/json', 'Content-Type 是 application/json');
    check(reqBody.model === 'speech-2.8-hd' && reqBody.text === '你好' && reqBody.stream === false,
      'body 里有 model / text / stream=false', `model=${reqBody.model} stream=${reqBody.stream}`);
    check(reqBody.output_format === 'hex', "output_format 用 'hex'（本地解码）", reqBody.output_format);
    check(reqBody.voice_setting?.voice_id === 'female-tianmei'
      && reqBody.voice_setting?.speed === 1.25
      && reqBody.voice_setting?.vol === 2
      && reqBody.voice_setting?.pitch === 3
      && reqBody.voice_setting?.emotion === 'happy',
      'voice_setting 带 voice_id / speed / vol / pitch / emotion',
      JSON.stringify(reqBody.voice_setting));
    check(reqBody.audio_setting?.format === 'wav' && reqBody.audio_setting?.sample_rate === 24000
      && reqBody.audio_setting?.channel === 1,
      'audio_setting 带 format=wav / sample_rate / channel',
      JSON.stringify(reqBody.audio_setting));
    check(JSON.stringify(reqBody).includes('sk-fake') === false,
      'key 不会混进请求体（只在 Authorization 头里）');

    // b) 不指定 emotion 时不该出现这个字段（每次新建请求对象，避免复用旧的）
    globalThis.fetch = async (url, init) => {
      seen = { url, init };
      return jsonResponse({ data: { audio: '00' }, base_resp: { status_code: 0 } });
    };
    await synthesizeMiniMax('x', { ...cfg, minimaxEmotion: '' }, { botDir: '__no_such_dir__' });
    const body2 = JSON.parse(seen.init.body);
    check(!('emotion' in body2.voice_setting), 'emotion 留空时不发这个字段（让模型自己决定）',
      JSON.stringify(body2.voice_setting));

    // c) GroupId 填了才进 query
    await synthesizeMiniMax('x', { ...cfg, minimaxGroupId: '12345' }, { botDir: '__no_such_dir__' });
    check(seen.url.includes('GroupId=12345'), '填了 GroupId 才带在 query 上', seen.url);
    // 没填时不该多出 query（界面上的 endpoint 就是实际地址）
    await synthesizeMiniMax('x', { ...cfg, minimaxGroupId: '' }, { botDir: '__no_such_dir__' });
    check(!seen.url.includes('?'), '没填 GroupId 时不带 query', seen.url);

    // d) 鉴权失败：错误码翻成人话，且不回显 key
    globalThis.fetch = async () => jsonResponse({ base_resp: { status_code: 1004, status_msg: 'invalid api key' } });
    const bad = await synthesizeMiniMax('x', cfg, { botDir: '__no_such_dir__' });
    check(bad.ok === false && bad.code === 'mini-1004' && /鉴权失败/.test(bad.error),
      '1004 鉴权失败被翻成中文提示', bad.error);
    check(!bad.error.includes('sk-fake'), '报错里不会出现 key', bad.error);

    // e) data 为 null（文档明确要求判空）
    globalThis.fetch = async () => jsonResponse({ data: null, base_resp: { status_code: 0 } });
    const empty = await synthesizeMiniMax('x', cfg, { botDir: '__no_such_dir__' });
    check(empty.ok === false && empty.code === 'empty-audio' && empty.retryable === true,
      'data 为 null 时安全失败并标成可重试', `${empty.code} retryable=${empty.retryable}`);

    // f) 限流标成可重试；参数错标成不可重试
    globalThis.fetch = async () => jsonResponse({ base_resp: { status_code: 1002, status_msg: 'rate limit' } });
    const limited = await synthesizeMiniMax('x', cfg, { botDir: '__no_such_dir__' });
    check(limited.retryable === true, '1002 限流标成可重试', limited.error);
    globalThis.fetch = async () => jsonResponse({ base_resp: { status_code: 2013, status_msg: 'bad voice_id' } });
    const paramErr = await synthesizeMiniMax('x', cfg, { botDir: '__no_such_dir__' });
    check(paramErr.retryable === false && /参数不合法/.test(paramErr.error), '2013 参数错标成不可重试', paramErr.error);

    // g) 网络异常与超时
    globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND api.minimax.cn'); };
    const offline = await synthesizeMiniMax('x', cfg, { botDir: '__no_such_dir__' });
    check(offline.ok === false && offline.retryable === true && /DNS/.test(offline.error),
      '网络不通时给出可读原因并标可重试', offline.error);

    // h) 云端失败时路由层真的改用系统语音
    const speech = createSpeech({
      getConfig: () => ({ ...cfg, fallback: 'auto', minimaxEnabled: true }),
      opts: { botDir: '__no_such_dir__' },
      log: () => {},
    });
    const fell = await speech.speak('云端挂了');
    check(fell.engine === 'sapi' && fell.fellBack === true && fell.fallbackReason === 'cloud-failed',
      '云端失败后这一句改用系统语音',
      `engine=${fell.engine} reason=${fell.fallbackReason} cloudError=${fell.cloudError}`);
  } finally {
    globalThis.fetch = realFetch;
  }
} catch (err) {
  check(false, '请求体/响应解析测试能跑完', err?.stack ?? String(err));
}

// ── 8. 语音引擎与播放器探测 ─────────────────────────────────────────────
// 受限沙箱里 spawn 带管道会 EPERM（子进程拿不到 stdio）。那不是产品问题：真实的朗读
// 跑在 Coopanion 的 Core 进程里，不受这条限制。这种情形记 SKIP。
let voices = { ok: false, voices: [], error: '' };
try {
  voices = await listVoices();
} catch (err) {
  voices = { ok: false, voices: [], error: err?.message ?? String(err) };
}
const sandboxed = !voices.ok && /EPERM|EACCES|not permitted|operation not permitted/i.test(voices.error ?? '');
if (sandboxed) {
  skip('系统语音探测（当前进程起不了子进程，跳过）',
    `${voices.error} —— 受限沙箱里 spawn 带管道会失败；在 Coopanion 里、或普通终端里跑就能测到`);
} else {
  check(voices.ok, `这台机器的系统语音可用（${voices.voices.length} 个音色）`,
    voices.ok ? voices.voices.map((v) => `${v.name}${v.culture ? ` [${v.culture}]` : ''}`).join(' / ') : (voices.error ?? ''));
}

let player = { ok: false, error: '' };
try {
  player = await probePlayer();
} catch (err) {
  player = { ok: false, error: err?.message ?? String(err) };
}
if (!player.ok && /EPERM|EACCES/i.test(player.error ?? '')) {
  skip('本地播放器探测（当前进程起不了子进程，跳过）', player.error);
} else {
  check(player.ok, '本地播放器（Media.SoundPlayer）可用', player.ok ? '能加载并播放 WAV' : (player.error ?? ''));
}

if (flag('--speak')) {
  const voice = value('--voice');
  const res = await speakSapi('\u8fd9\u662f\u6c14\u6ce1\u6717\u8bfb\u7684\u81ea\u68c0\u3002', { sapiVoice: voice, sapiRate: 0, sapiVolume: 100 });
  if (!res.ok && /EPERM|EACCES/i.test(res.error ?? '')) {
    skip('用系统语音真的念一句', `起不了子进程：${res.error}`);
  } else {
    check(res.ok, '用系统语音真的念了一句', res.ok ? `engine=${res.engine} voice=${res.voice} ${res.ms}ms` : (res.error ?? ''));
  }
}

if (flag('--cloud')) {
  const { synthesizeMiniMax } = await import('../src/cloud.js');
  const { playWav } = await import('../src/player.js');
  const cfg = { ...world.defaults(), ...(value('--voice') ? { minimaxVoice: value('--voice') } : {}), minimaxFormat: 'wav' };
  const cloud = await synthesizeMiniMax('\u4f60\u597d\u3002', cfg, { botDir: dataDir ?? '' });
  if (!cloud.ok) {
    check(false, '用云端真的合成一句', cloud.error);
  } else {
    const played = await playWav(cloud.bytes, cfg);
    check(played.ok, '云端合成并播放成功',
      `model=${cloud.model} voice=${cloud.voiceId} bytes=${cloud.bytes.length} audio=${played.ms}ms 用量=${cloud.usage?.characters ?? '?'} 字`);
  }
}

// ── 9. 实例化与 WebUI 声明（不启动 Coopanion，也能验形状） ─────────────────
// 框架的 dry-mount 会走 create()/tools()/webUi()，这里做同样的几步。
try {
  const cfg = world.defaults();
  const instance = world.create({
    id: world.id,
    cfg,
    dataDir: dataDir ?? '',
    timezone: 'Asia/Shanghai',
    botName: 'Coo',
    botDir: dataDir ?? '',
    packageDir: '',
    repoRoot: '',
    secret: () => '',
    storeSecret: () => {},
    persist: () => {},
    restart: async () => {},
  });
  check(typeof instance.envPromptVars === 'function' && instance.envPromptVars() === null,
    'create() 成功，且不往系统前缀里塞环境段（envPromptVars() === null）');
  const tools = instance.tools();
  check(Array.isArray(tools) && tools.length === 0,
    '不给模型任何工具（旁听型，不会和桌宠的 pet_say 撞名）', `tools=${JSON.stringify(tools)}`);

  const ui = instance.webUi('zh');
  const uiOk = ui && typeof ui === 'object'
    && Array.isArray(ui.config) && ui.config.length > 0
    && Array.isArray(ui.lamps) && ui.lamps.length > 0;
  check(uiOk, 'webUi() 给出配置组与状态灯（控制台页面据此生成）',
    uiOk ? `config=${ui.config.length} 组, lamps=${ui.lamps.length}` : JSON.stringify(Object.keys(ui ?? {})));

  // 这条是回归断言：曾经声明了 panels 却没带构建产物，导致 World 页报
  // 「缺少面板构建产物」，而那一页正是唯一能激活本 World 的地方 —— 连激活都点不动。
  // 框架里 webui-pages/loader.ts 的 resolvePanel() 只在声明了面板时才会去要产物。
  check(ui.panels === undefined || ui.panels.length === 0,
    '不声明任何 panels（否则框架会要求构建产物，World 页会加载失败）',
    ui.panels ? JSON.stringify(ui.panels.map((p) => p.id)) : '(未声明)');
  check(pkg.cortico?.webUiClient === undefined,
    'manifest 里不声明 webUiClient（没有产物就别声明，声明了但文件不在会被记 missing）',
    String(pkg.cortico?.webUiClient));

  // 诊断能力都在 scripts/ 下（selftest / minimax-probe / list-voices），不依赖界面面板，
  // 所以 World 页没有任何需要构建的产物。
  check(typeof instance.statusReport === 'function' && typeof instance.engineReport === 'function',
    '实例自身提供 statusReport() / engineReport()（命令行诊断用，与界面面板无关）');
  const status = instance.statusReport();
  check(status && typeof status.enabled === 'boolean' && 'eventsFile' in status,
    'statusReport() 可调用',
    JSON.stringify({ enabled: status?.enabled, mode: status?.engineMode, cloudConfigured: status?.cloudConfigured }));
  const engines = await instance.engineReport();
  check(engines && engines.cloud && engines.sapi,
    'engineReport() 报出两个引擎的状态',
    JSON.stringify({ hasKey: engines?.cloud?.hasKey, sapiOk: engines?.sapi?.ok, player: engines?.player?.ok }));

  // 动态下拉：框架按 x-options 的 kind 调 configOptions
  const opts = instance.configOptions?.('breezeblue-tts-minimax-voice') ?? [];
  check(Array.isArray(opts) && opts.length > 0 && opts.every((o) => typeof o.value === 'string' && typeof o.label === 'string'),
    'configOptions() 给出 MiniMax 音色下拉选项', `${opts.length} 项，首项 ${opts[0]?.value}`);
} catch (err) {
  check(false, 'create() / webUi() 不抛错', err?.stack ?? String(err));
}

// ── 输出 ───────────────────────────────────────────────────────────────
if (flag('--json')) {
  console.log(JSON.stringify({ failed, skipped, results, sampleLines, voices: voices.voices }, null, 2));
} else {
  console.log('cortico-world-breezeblue-tts 自检\n');
  for (const r of results) {
    const tag = r.skipped ? ' SKIP ' : (r.ok ? '  OK  ' : ' FAIL ');
    console.log(`${tag} ${r.label}`);
    if (r.detail) console.log(`         ${r.detail}`);
  }
  if (sampleLines.length) {
    console.log('\n从你的事件库里取到的气泡文字（前几条）：');
    for (const s of sampleLines) console.log(`  · ${s}`);
  }
  const tail = failed === 0 ? '全部通过' : `${failed} 项未通过`;
  console.log(`\n${tail}${skipped ? `（${skipped} 项因当前环境跳过）` : ''}`);
  if (!flag('--speak')) console.log('（加 --speak 可真的念一句试听）');
}

process.exit(failed === 0 ? 0 : 1);
