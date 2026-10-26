/**
 * cortico-world-breezeblue-tts —— Coopanion 扩展（kind: world, api: 6）
 *
 * 干什么：盯着 Coopanion 事件库里桌宠自己记的 desktop-pet.self 事件，把 meta.kind 为 say
 * 的 beats[].text（＝气泡里逐段显示的文字）交给语音合成念出来。
 * 声音来源可选 BreezeBlue / MiniMax 云端 TTS，失败或缺少配置时自动改用
 * Windows 自带语音（System.Speech / SAPI）。默认关。
 *
 * 为什么这么接：Coopanion 0.2.1 的 World 接口不允许一个 World 订阅另一个 World 的工具调用
 * 或事件，pet_say 也没有推出任何事件（桌宠把它记成 archive-only 的 self 事件）。事件库是
 * 唯一能稳定拿到"气泡显示过什么"的地方。详细依据见 README「依赖的契约」。
 *
 * 密钥：绝不写死。从环境变量或部署目录的 .env 读（见 src/secrets.js），日志一律脱敏。
 */
import { createEventWatcher, resolveDataDir, currentEventsFile } from './events.js';
import { createSpeech, probeEngines } from './speech.js';
import { createSpeaker } from './queue.js';
import { petVoiceConfigGroups, OPTION_KINDS, WORLD_ID } from './config-schema.js';
import { clampInt } from './config.js';
import { createLog } from './log.js';
import { CHINESE_VOICES } from './cloud.js';

/** 默认关。加进 config.json 也不改变行为，直到有人在控制台或 config.json 里打开。 */
function defaults() {
  return {
    enabled: false,
    // 声音来源：auto = 云端优先，失败回退系统语音；sapi = 只用系统语音
    fallback: 'auto',
    readAsk: true,
    minChars: 1,
    maxChars: 220,

    cloudProvider: 'breeze',
    breezeEnabled: true,
    breezeApiKey: '',
    breezeApiKeyEnv: '',
    breezeVoice: '',
    breezeModel: 'breeze-tts-2',
    breezeLanguageCode: '',
    breezeInstructions: '',
    breezeSpeed: 1,
    breezeVolume: 1,
    breezeGuidanceScale: 1,
    breezeSpeakerBoost: false,
    breezeTimeoutMs: 15000,

    // MiniMax 云端
    minimaxEnabled: true,
    minimaxEndpoint: 'cn',
    minimaxModel: 'speech-2.8-turbo',
    minimaxVoice: 'female-shaonv',
    minimaxSpeed: 1,
    minimaxVolume: 1,
    minimaxPitch: 0,
    minimaxEmotion: '',
    minimaxSampleRate: '32000',
    minimaxLanguageBoost: 'auto',
    minimaxFormat: 'wav',
    minimaxTimeoutMs: 15000,
    // key 的读取方式：这里只放"去哪个环境变量找"，key 本身不放代码里
    minimaxApiKeyEnv: '',
    minimaxApiKey: '',
    minimaxGroupId: '',

    // 系统语音（回退）
    sapiVoice: '',
    sapiRate: 0,
    sapiVolume: 100,

    // 其它
    dataDir: '',
    replayExisting: false,
    playTimeoutSec: 60,
    verbose: false,
  };
}

/** 动态下拉：MiniMax 音色。world.configOptions 与实例的 configOptions() 共用这一份。 */
function minimaxVoiceOptions() {
  return [
    ...CHINESE_VOICES.map((v) => ({ value: v.id, label: `${v.label}（${v.id}）` })),
    // 复刻/自建音色不在固定表里，给一个空项提示可以直接填 ID
    { value: '', label: '（留空＝少女音色 female-shaonv；也可直接填自己的音色 ID）' },
  ];
}

/** 念一句的实例。 */
class PetVoiceWorld {
  constructor(ctx) {
    this.id = WORLD_ID;
    this.cfg = ctx.cfg;
    this.ctx = ctx;
    this.dataDir = resolveDataDir(ctx.dataDir);
    this.host = null;
    this._log = createLog(null, ctx);
    this.watcher = null;
    this.speaker = null;
    this.speech = null;
    this.probe = null;
    this.lastError = '';
    this.lastSpokenAt = 0;
    this.lastSpokenText = '';
    this.endedReason = null;

    // 扩展的 World 默认没有 enabled 字段（persona 的 declares 里只列了内建 World），
    // 所以它默认是"未激活"。这里说清楚一点：配置页要激活后才出现。
    if (this.cfg.enabled !== true) {
      this.logAt('info', 'cortico-world-breezeblue-tts 已安装但未激活：到控制台「World」页点它的电源按钮激活后，才会出现「气泡朗读」配置页（朗读开关仍默认关）');
    }
  }

  /** 环境模板：本 World 不给 bot 任何环境信息（默认没有 role=envPrompt 的模板，返回 null 更明确）。 */
  envPromptVars() { return null; }

  /** 不给模型任何工具：这个 World 只旁听，模型看不见它。 */
  tools() { return []; }

  /** 按语言给配置表单（WorldDefinition.configOptions 之外，实例也提供一份动态选项）。 */
  configOptions(kind) {
    if (kind === OPTION_KINDS.minimaxVoice) return minimaxVoiceOptions();
    return [];
  }

  /**
   * 控制台里这一页的内容。
   *
   * 重要：这里**不能声明 panels**。框架的 World 页在渲染一个声明的面板时会去加载
   * `cortico.webUiClient` 指向的构建产物，没有产物就直接抛
   * 「缺少面板构建产物」(webui-pages/loader.ts 的 noBundle)，
   * 而 World 页正是唯一能激活这个 World 的地方——面板挂了就连激活都点不动（踩过）。
   *
   * 配置组走的是另一条路：host.ts 在 panels 为空、configGroups 非空时直接渲染配置页
   * （PROVIDER_CONFIG_ROUTE），配置表单由框架按 JSON Schema 生成，**不需要任何产物**。
   * 所以这里只给 config + badges + lamps。
   */
  webUi(language = 'zh') {
    const en = language === 'en';
    const on = this.cfg.enabled === true;
    const s = this.speaker?.stats() ?? {};
    const sp = this.speech?.status?.() ?? {};
    const state = !on ? 'offline' : (this.endedReason ? 'error' : 'online');
    const engineLabel = !on ? (en ? 'off' : '关')
      : sp.mode === 'auto' && sp.cloudReady
        ? (sp.breakUntil ? (en ? 'fallback' : '回退中') : (en ? 'cloud' : '云端'))
        : (en ? 'system voice' : '系统语音');
    return {
      label: en ? 'BreezeBlue bubble speech' : 'BreezeBlue 气泡朗读',
      config: petVoiceConfigGroups(language),
      badges: [
        { label: en ? 'State' : '状态', value: engineLabel, tone: on ? (sp.mode === 'auto' && sp.cloudReady ? 'on' : 'plain') : 'off' },
        { label: en ? 'Cloud' : '云端', value: s.cloudSpoken ?? 0 },
        { label: en ? 'Fallback' : '回退', value: s.fellBack ?? 0 },
        { label: en ? 'Waiting' : '排队', value: s.queued ?? 0 },
      ],
      lamps: [{
        label: en ? 'Bubble speech' : '气泡朗读',
        state,
        hint: !on
          ? (en ? 'Off. Turn on "Read bubbles aloud" on this page.' : '已关闭。在本页配置里打开「开启朗读」。')
          : (this.endedReason
            ?? (sp.mode === 'sapi'
              ? (en ? 'System voice selected.' : '已选择系统语音。')
              : (sp.cloudReady
                ? `${sp.providerLabel ?? ''} ${sp.model ?? ''}${sp.breakUntil ? (en ? ' (cooling down)' : '（熔断中，暂用系统语音）') : ''}`
                : (en ? 'Missing API key or voice ID: using system voice.' : '缺少 API key 或音色 ID：正在用系统语音。')))),
      }],
    };
  }

  /** 两个引擎各自的状态：key 有没有、系统语音几个、播放器行不行。 */
  async engineReport() {
    const cfg = this.cfg;
    this.probe = await probeEngines(cfg, { botDir: this.dataDir, dataDir: this.dataDir });
    return { ok: true, ...this.probe, speech: this.speech?.status?.() ?? {} };
  }

  /** 现在在读哪个文件、念了多少、上次错在哪。 */
  statusReport() {
    const w = this.watcher?.state() ?? { file: null, offset: 0 };
    const s = this.speaker?.stats() ?? {};
    const sp = this.speech?.status?.() ?? {};
    const file = w.file ?? currentEventsFile(this.dataDir);
    return {
      enabled: this.cfg.enabled === true,
      dataDir: this.dataDir,
      eventsFile: file,
      offset: w.offset,
      engineMode: sp.mode ?? this.cfg.fallback,
      cloudConfigured: sp.cloudConfigured ?? false,
      keyFrom: sp.keyFrom ?? null,
      breakUntil: sp.breakUntil ?? null,
      lastCloudError: sp.lastCloudError ?? '',
      spoken: s.spoken ?? 0,
      cloudSpoken: s.cloudSpoken ?? 0,
      sapiSpoken: s.sapiSpoken ?? 0,
      fellBack: s.fellBack ?? 0,
      dropped: s.dropped ?? 0,
      failed: s.failed ?? 0,
      queued: s.queued ?? 0,
      lastEngine: s.lastEngine ?? '',
      lastError: s.lastError || this.lastError,
      lastSpokenAt: this.lastSpokenAt,
      lastSpokenText: this.lastSpokenText,
      endedReason: this.endedReason,
    };
  }

  async start(host) {
    this.host = host;
    // 挂载后就有框架的 Logger 了，从这里开始走它（进运行日志 log.jsonl）。
    this._log = createLog(host, this.ctx);
    const cfg = this.cfg;

    // 朗读引擎与串行队列：一直在，开关只决定"要不要往里塞句子"。
    this.speech = createSpeech({
      getConfig: () => this.cfg,
      opts: { botDir: this.dataDir, dataDir: this.dataDir },
      log: (level, msg) => this.logAt(level, msg),
    });
    this.speaker = createSpeaker({
      speak: (text) => this.speech.speak(text),
      onEvent: (e) => this.onSpeakerEvent(e),
    });

    if (cfg.enabled !== true) {
      this.logAt('info', '气泡朗读已装好但没打开（worlds.breezeblue-tts.enabled = false）');
      return;
    }

    // 起来探一次引擎，好让面板和日志有话可说。探不到不算致命：可能没配 key、沙箱挡了
    // 音频设备、或这台机器没有语音包；都只影响发声，不该拦住 World 挂载。
    try {
      const report = await this.engineReport();
      const cloud = report.cloud ?? {};
      const sapi = report.sapi ?? {};
      this.logAt('info', cloud.hasKey
        ? `${cloud.label} key 已配置：来自 ${cloud.keyFrom}，模型 ${cloud.model}，音色 ${cloud.voice || '未填写'}${cloud.ready ? '' : '；将只用系统语音'}`
        : `没找到 ${cloud.label} API key（找过：${(cloud.candidates ?? []).join(' / ')}，以及部署目录的 .env）；将只用系统语音`);
      this.logAt('info', sapi.ok
        ? `系统语音可用（${sapi.voiceCount} 个音色），作为回退`
        : `系统语音不可用：${sapi.error ?? '未知原因'}（云端成功时不影响）`);
      if (cloud.hasKey && report.player && report.player.ok === false) {
        this.logAt('warn', `本地播放器探测失败：${report.player.error}；云端合成可能放不出声`);
      }
    } catch (err) {
      this.logAt('warn', `探测语音引擎出错：${err?.message ?? err}`);
    }

    if (!this.dataDir) {
      this.endedReason = '找不到部署目录（dataDir）';
      this.logAt('error', `${this.endedReason}；请在控制台把「事件目录」填成 Coopanion 的部署目录（含 config.json、.env 与 data\\runs）`);
      return;
    }

    this.watcher = createEventWatcher({
      dataDir: this.dataDir,
      replayExisting: cfg.replayExisting === true,
      onLog: (level, msg) => this.logAt(level, msg),
      onText: (text) => this.onBubbleText(text),
    });
    await this.watcher.start();
    this.endedReason = null;
    this.logAt('info', `气泡朗读已启动：${this.dataDir}`);
  }

  async stop() {
    this.watcher?.stop();
    this.watcher = null;
    this.speaker?.stop();
    this.speaker = null;
    this.speech = null;
    this.logAt('info', '气泡朗读已停止');
  }

  /** 一条该念的文本从事件库里出来了。 */
  onBubbleText(text) {
    const cfg = this.cfg;
    if (cfg.enabled !== true) return;
    const maxChars = clampInt(cfg.maxChars, 40, 500, 220);
    const line = text.length > maxChars ? `${text.slice(0, maxChars - 1)}\u2026` : text;
    if (line.length < clampInt(cfg.minChars, 0, 20, 1)) return;
    const verdict = this.speaker?.say(line);
    if (cfg.verbose === true) {
      this.logAt('info', verdict === 'queued' ? `朗读排队：${line}` : `朗读未排队（${verdict}）：${line}`);
    }
  }

  onSpeakerEvent(e) {
    const cfg = this.cfg;
    if (e.kind === 'spoken') {
      this.lastSpokenAt = Date.now();
      this.lastSpokenText = e.text;
      if (cfg.verbose === true) {
        const via = ['minimax', 'breeze'].includes(e.engine)
          ? `云端 ${e.model ?? ''}${e.audioMs ? ` ${Math.round(e.audioMs / 100) / 10}s` : ''}`
          : (e.fellBack ? `系统语音（云端失败：${e.cloudError ?? ''}）` : '系统语音');
        this.logAt('info', `已念 [${via}]：${e.text}`);
      }
    } else if (e.kind === 'failed') {
      this.lastError = e.error ?? '';
      this.logAt('warn', `朗读失败（${e.engine ?? '?'}）：${this.lastError}｜原句：${e.text}`);
    } else if (e.kind === 'dropped') {
      if (cfg.verbose === true) this.logAt('info', `丢弃一句（${e.reason}）：${e.text}`);
    }
  }

  logAt(level, message) {
    try {
      this._log?.(level, message);
    } catch { /* 日志失败不该影响朗读 */ }
  }
}

/** 这个扩展对框架的声明。 */
const world = {
  id: WORLD_ID,
  label: 'BreezeBlue 气泡朗读',
  defaults,
  /** 控制台里的动态下拉（框架按 x-options 的 kind 调它）。 */
  configOptions: (kind) => (kind === OPTION_KINDS.minimaxVoice ? minimaxVoiceOptions() : []),
  create: (ctx) => new PetVoiceWorld(ctx),
  // 自描述：不给工具、不推事件（旁听型 World，模型看不见）
  describe: { tools: [], events: [] },
};

export default world;
export { PetVoiceWorld, defaults as petVoiceDefaults };
