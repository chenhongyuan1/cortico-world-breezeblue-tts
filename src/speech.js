/**
 * 合成引擎路由：所选云端（BreezeBlue / MiniMax）优先，失败回退系统自带语音。
 *
 * 需求对应：
 *   - key 没填 → 直接用系统语音，并且**不去发请求**（不必每句都白等一次超时）；
 *   - 网络/接口失败 → 这一句立刻改用系统语音，气泡不会因此卡住；
 *   - 云端连续失败 → 熔断一段时间，期间全部走系统语音，到点自动再试一次云端。
 *
 * "不卡住气泡"的做法：这一段朗读本身就是异步的（不参与 bot 的工具调用），所以最坏情况
 * 只是这一句晚一点出声或没声音，工具回执与气泡显示不受影响。加上超时、熔断与队列侧的
 * 过期丢弃，就不会越堆越多。
 */
import { synthesizeMiniMax, keyStatus } from './cloud.js';
import { synthesizeBreeze, breezeKeyStatus, BREEZE_BASE_URL, BREEZE_DEFAULT_MODEL } from './breeze.js';
import { playWav, probePlayer } from './player.js';
import { speakSapi, listVoices } from './tts.js';
import { clampInt } from './config.js';
import { truncate } from './text.js';

/** 云端连续失败几次后熔断。 */
export const BREAK_AFTER = 3;
/** 熔断后多久允许再试一次云端（毫秒）。 */
export const BREAK_COOLDOWN_MS = 120_000;
/** 云端返回的音频格式；本地播放器按 WAV 播，所以固定要 wav。 */
const CLOUD_FORMAT = 'wav';

/**
 * 把活配置整理成引擎参数。每次朗读都调用，所以改配置立刻生效。
 * 注意：这里只取"怎么说话"，密钥由 secrets.js 另外解析，绝不进日志。
 */
export function engineConfig(cfg = {}) {
  return {
    cloudProvider: cfg.cloudProvider === 'minimax' ? 'minimax' : 'breeze',
    breezeEnabled: cfg.breezeEnabled !== false,
    breezeApiKey: cfg.breezeApiKey,
    breezeApiKeyEnv: cfg.breezeApiKeyEnv,
    breezeVoice: cfg.breezeVoice,
    breezeModel: cfg.breezeModel ?? BREEZE_DEFAULT_MODEL,
    breezeLanguageCode: cfg.breezeLanguageCode,
    breezeInstructions: cfg.breezeInstructions,
    breezeSpeed: cfg.breezeSpeed,
    breezeVolume: cfg.breezeVolume,
    breezeGuidanceScale: cfg.breezeGuidanceScale,
    breezeSpeakerBoost: cfg.breezeSpeakerBoost,
    breezeTimeoutMs: clampInt(cfg.breezeTimeoutMs, 2000, 120000, 15000),
    fallback: cfg.fallback === 'sapi' ? 'sapi' : 'auto',
    minimaxEnabled: cfg.minimaxEnabled === true,
    minimaxEndpoint: cfg.minimaxEndpoint === 'io' ? 'io' : 'cn',
    minimaxApiKey: cfg.minimaxApiKey,
    minimaxApiKeyEnv: cfg.minimaxApiKeyEnv,
    minimaxGroupId: cfg.minimaxGroupId,
    minimaxModel: cfg.minimaxModel,
    minimaxVoice: cfg.minimaxVoice,
    minimaxSpeed: cfg.minimaxSpeed,
    minimaxVolume: cfg.minimaxVolume,
    minimaxPitch: cfg.minimaxPitch,
    minimaxEmotion: cfg.minimaxEmotion,
    minimaxSampleRate: cfg.minimaxSampleRate,
    minimaxLevel: cfg.minimaxLevel,
    minimaxLanguageBoost: cfg.minimaxLanguageBoost,
    minimaxTimeoutMs: clampInt(cfg.minimaxTimeoutMs, 2000, 120_000, 15_000),
    minimaxFormat: CLOUD_FORMAT,
    playTimeoutSec: clampInt(cfg.playTimeoutSec, 3, 600, 60),
    sapiVoice: cfg.sapiVoice ?? cfg.voice,
    sapiRate: cfg.sapiRate ?? cfg.rate,
    sapiVolume: cfg.sapiVolume ?? cfg.volume,
    maxChars: clampInt(cfg.maxChars, 40, 500, 220),
  };
}

/**
 * 造一个朗读函数：speak(text) → 结果。
 *
 * engine 字段为 'breeze' / 'minimax' / 'sapi'，便于面板与日志显示；
 * fellBack 为真表示云端没成、改用了系统语音，cloudError 里是原因（已脱敏）。
 */
function cloudFor(cfg, opts) {
  if (cfg.cloudProvider === 'minimax') return {
    id: 'minimax', label: 'MiniMax', enabled: cfg.minimaxEnabled,
    keys: keyStatus(cfg, opts), synthesize: synthesizeMiniMax,
    model: cfg.minimaxModel, voice: cfg.minimaxVoice, endpoint: cfg.minimaxEndpoint,
  };
  return {
    id: 'breeze', label: 'BreezeBlue', enabled: cfg.breezeEnabled,
    keys: breezeKeyStatus(cfg, opts), synthesize: synthesizeBreeze,
    model: cfg.breezeModel, voice: cfg.breezeVoice, endpoint: BREEZE_BASE_URL,
  };
}

export function createSpeech({ getConfig, opts = {}, log = () => {}, engines = {} }) {
  const systemSpeak = engines.speakSapi ?? speakSapi;
  const play = engines.playWav ?? playWav;
  /** 云端熔断状态。 */
  let consecutiveFailures = 0;
  let breakUntil = 0;
  let lastCloudError = '';
  let lastEngine = '';
  let cloudSpoken = 0;
  let fallbackSpoken = 0;
  let lastProvider = '';

  return {
    async speak(text) {
      const cfg = engineConfig(getConfig());
      const provider = cloudFor(cfg, opts);
      if (provider.id !== lastProvider) {
        consecutiveFailures = 0;
        breakUntil = 0;
        lastCloudError = '';
        lastProvider = provider.id;
      }
      const line = truncate(text, cfg.maxChars);
      if (!line) return { ok: true, skipped: 'empty', ms: 0, engine: 'none' };

      // 只用系统语音：用户明确选了 fallback: sapi，或云端总开关关着
      const wantCloud = cfg.fallback === 'auto' && provider.enabled;

      if (!wantCloud) {
        const res = await systemSpeak(line, cfg);
        lastEngine = res.ok ? 'sapi' : lastEngine;
        if (res.ok) fallbackSpoken += 1;
        return { ...res, engine: 'sapi', model: null };
      }

      // 云端可用性：没 key 或正在熔断都直接走系统语音，不发请求
      const now = Date.now();
      const keyAvailable = provider.keys.configured;
      const voiceAvailable = provider.id !== 'breeze' || Boolean(cfg.breezeVoice?.trim());
      const inBreak = now < breakUntil;

      if (!keyAvailable || !voiceAvailable || inBreak) {
        const why = !keyAvailable
          ? 'no-key'
          : (!voiceAvailable ? 'no-voice' : 'cooldown');
        const res = await systemSpeak(line, cfg);
        if (res.ok) fallbackSpoken += 1;
        lastEngine = res.ok ? 'sapi' : lastEngine;
        return {
          ...res,
          engine: 'sapi',
          fellBack: true,
          fallbackReason: why,
          cloudError: why === 'no-key' ? `没配置 ${provider.label} API key`
            : (why === 'no-voice' ? '未配置 BreezeBlue 音色 ID' : lastCloudError),
        };
      }

      // 先试云端
      const cloud = await provider.synthesize(line, cfg, opts);
      if (cloud.ok) {
        const played = await play(cloud.bytes, cfg).catch((err) => ({ ok: false, error: err?.message ?? String(err) }));
        if (played.ok) {
          consecutiveFailures = 0;
          lastCloudError = '';
          lastEngine = provider.id;
          cloudSpoken += 1;
          return {
            ok: true,
            engine: provider.id,
            ms: cloud.ms,
            audioMs: played.ms,
            model: cloud.model,
            voice: cloud.voiceId,
            keyFrom: cloud.keyFrom,
            usage: cloud.usage,
            traceId: cloud.traceId,
          };
        }
        // 合成成功但放不出来：算云端失败（别重复播两次），转系统语音
        lastCloudError = `播放失败：${played.error}`;
        log('warn', `${lastCloudError}；这一句改用系统语音`);
        consecutiveFailures += 1;
      } else {
        lastCloudError = cloud.error;
        consecutiveFailures += 1;
        log('warn', `${provider.label} 合成失败（第 ${consecutiveFailures} 次）：${cloud.error}`);
      }

      if (consecutiveFailures >= BREAK_AFTER) {
        breakUntil = Date.now() + BREAK_COOLDOWN_MS;
        consecutiveFailures = 0;
        log('warn', `${provider.label} 连续失败，暂停云端 ${Math.round(BREAK_COOLDOWN_MS / 1000)} 秒，期间只用系统语音`);
      }

      // 回退系统语音；回退也失败就只有这一句没声音，不影响后续
      const res = await systemSpeak(line, cfg);
      if (res.ok) fallbackSpoken += 1;
      lastEngine = res.ok ? 'sapi' : lastEngine;
      return {
        ...res,
        engine: 'sapi',
        fellBack: true,
        fallbackReason: 'cloud-failed',
        cloudError: lastCloudError,
      };
    },

    reset() {
      consecutiveFailures = 0;
      breakUntil = 0;
      lastCloudError = '';
    },

    status() {
      const cfg = engineConfig(getConfig());
      const provider = cloudFor(cfg, opts);
      const keys = provider.keys;
      const mode = cfg.fallback === 'sapi' ? 'sapi' : (provider.enabled ? 'auto' : 'sapi');
      return {
        mode,
        provider: provider.id,
        providerLabel: provider.label,
        cloudConfigured: keys.configured,
        cloudReady: keys.configured && (provider.id !== 'breeze' || Boolean(cfg.breezeVoice?.trim())),
        keyFrom: keys.from,
        keyCandidates: keys.candidates,
        model: provider.model,
        voice: provider.voice,
        endpoint: provider.endpoint,
        breakUntil: breakUntil > Date.now() ? new Date(breakUntil).toISOString() : null,
        lastCloudError,
        lastEngine,
        cloudSpoken,
        fallbackSpoken,
      };
    },
  };
}

/** 探测两个引擎各能不能用（面板与自检用）。 */
export async function probeEngines(cfg = {}, opts = {}) {
  const normalized = engineConfig(cfg);
  const provider = cloudFor(normalized, opts);
  const keys = provider.keys;
  const voices = await listVoices().catch((err) => ({ ok: false, voices: [], error: err?.message ?? String(err) }));
  const player = await probePlayer().catch((err) => ({ ok: false, error: err?.message ?? String(err) }));
  return {
    cloud: {
      enabled: provider.enabled,
      provider: provider.id,
      label: provider.label,
      model: provider.model,
      voice: provider.voice,
      ready: keys.configured && (provider.id !== 'breeze' || Boolean(normalized.breezeVoice?.trim())),
      hasKey: keys.configured,
      keyFrom: keys.from,
      candidates: keys.candidates,
    },
    sapi: { ok: voices.ok === true, voiceCount: voices.voices?.length ?? 0, error: voices.error },
    player,
  };
}
