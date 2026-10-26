/**
 * MiniMax 云端语音合成（T2A v2）。
 *
 * 接口（依据官方文档，2025-xx 版；见 README「MiniMax 接口依据」）：
 *   POST https://api.minimax.io/v1/t2a_v2    国际站
 *   POST https://api.minimax.cn/v1/t2a_v2    国内站
 *   Authorization: Bearer <API_key>          key 在控制台「接口密钥」页
 *   Content-Type: application/json
 *
 * 请求要点：
 *   model        speech-2.8-hd / speech-2.8-turbo / speech-2.6-hd / speech-2.6-turbo /
 *                speech-02-hd / speech-02-turbo / speech-01-hd / speech-01-turbo
 *   voice_setting{ voice_id, speed[0.5,2], vol(0,10], pitch[-12,12], emotion? }
 *   audio_setting{ sample_rate, bitrate, format, channel }
 *   output_format  'hex'（默认）或 'url'
 *   非流式：stream=false，返回 data.audio 是十六进制编码的音频
 *
 * 响应要点：
 *   base_resp.status_code 0 为成功；1004 鉴权失败、1002/1039 限流、2013 参数错、1042 非法字符过多
 *   data 可能为 null，必须判空
 *
 * 本模块只负责"文字 → WAV 字节"，不碰队列、不碰播放；失败一律返回 { ok:false, error }，
 * 绝不抛出去影响气泡。
 */
import { resolveApiKey, resolveGroupId, redact, DEFAULT_KEY_ENVS } from './secrets.js';

/** 两个站点；国内机器默认走 .cn。 */
export const ENDPOINTS = {
  cn: 'https://api.minimax.cn/v1/t2a_v2',
  io: 'https://api.minimax.io/v1/t2a_v2',
};

/** 官方文档列出的全部模型，从新到旧。 */
export const MINIMAX_MODELS = [
  'speech-2.8-hd',
  'speech-2.8-turbo',
  'speech-2.6-hd',
  'speech-2.6-turbo',
  'speech-02-hd',
  'speech-02-turbo',
  'speech-01-hd',
  'speech-01-turbo',
];

/** 官方系统音色列表里适合中文桌宠的一部分，供控制台下拉选择。 */
export const CHINESE_VOICES = [
  { id: 'female-shaonv', label: '少女音色' },
  { id: 'female-tianmei', label: '甜美女性音色' },
  { id: 'female-yujie', label: '御姐音色' },
  { id: 'female-chengshu', label: '成熟女性音色' },
  { id: 'lovely_girl', label: '萌萌女童' },
  { id: 'Chinese (Mandarin)_Sweet_Lady', label: '甜美女声' },
  { id: 'Chinese (Mandarin)_Warm_Girl', label: '温暖少女' },
  { id: 'Chinese (Mandarin)_Cute_Spirit', label: '憨憨萌兽' },
  { id: 'Chinese (Mandarin)_Soft_Girl', label: '柔和少女' },
  { id: 'Chinese (Mandarin)_Crisp_Girl', label: '清脆少女' },
  { id: 'male-qn-qingse', label: '青涩青年音色' },
  { id: 'junlang_nanyou', label: '俊朗男友' },
  { id: 'Chinese (Mandarin)_Gentle_Youth', label: '温润青年' },
  { id: 'Chinese (Mandarin)_Radio_Host', label: '电台男主播' },
];

/** 支持 emotion 的模型（speech-01 起都支持；fluent/whisper 仅 2.6 系列）。 */
export const EMOTIONS = ['', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper'];

/** 各模型支持输出的音频格式（官方文档：mp3 / pcm / flac / wav / pcmu_raw / pcmu_wav / opus）。 */
export const AUDIO_FORMATS = ['wav', 'mp3', 'flac', 'pcm'];

const DEFAULT_TIMEOUT_MS = 15_000;

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
};

/** 这台机器上有没有 key；只看有没有，不返回内容。 */
export function hasApiKey(cfg, opts) {
  return resolveApiKey(cfg, opts).key !== '';
}

/** 给面板看的密钥来源说明（不含 key 本身）。 */
export function keyStatus(cfg, opts) {
  const res = resolveApiKey(cfg, opts);
  return {
    configured: res.key !== '',
    from: res.from || null,
    candidates: DEFAULT_KEY_ENVS,
    searched: res.tried.slice(0, 8),
    groupId: resolveGroupId(cfg, opts).groupId !== '',
  };
}

/** 把 HTTP/网络层的失败翻成一句人话（已脱敏）。 */
function describeFailure(err, secrets) {
  const msg = redact(err?.message ?? String(err), secrets);
  if (err?.name === 'AbortError' || /aborted|timeout/i.test(msg)) return `请求超时：${msg}`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return `DNS 解析失败（网络或代理问题）：${msg}`;
  if (/ECONNREFUSED|ECONNRESET|socket hang up/i.test(msg)) return `连接失败：${msg}`;
  if (/certificate|TLS|SSL/i.test(msg)) return `TLS/证书问题（公司代理常见）：${msg}`;
  return msg;
}

/** 官方错误码 → 人话。 */
function describeStatus(code, msg) {
  switch (Number(code)) {
    case 1004: return '鉴权失败：API key 不对或没开通（检查填的 key 与站点是否匹配）';
    case 1002: return '触发限流（rate limit），稍后会重试';
    case 1039: return '触发 TPM 限流，稍后会重试';
    case 1042: return '文本里非法字符超过 10%，这段跳过了';
    case 2013: return `参数不合法（检查 model / voice_id / speed 等）：${msg || ''}`.trim();
    case 1001: return '服务端超时，稍后会重试';
    default: return `MiniMax 返回错误 ${code}：${msg || '未知原因'}`;
  }
}

/**
 * 合成一句话，返回 WAV 字节。
 *
 * 返回 { ok:true, bytes, ms, usage, traceId } 或 { ok:false, error, code?, retryable? }。
 * retryable 表示"下次可能成功"（网络抖动、限流），路由层据此决定要不要退回系统语音。
 */
export async function synthesizeMiniMax(text, cfg = {}, opts = {}) {
  const { key, from } = resolveApiKey(cfg, opts);
  if (!key) {
    return {
      ok: false,
      code: 'no-key',
      error: `没找到 MiniMax API key（找过：${(resolveApiKey(cfg, opts).tried).slice(0, 4).join('、') || '配置与环境变量'}）`,
      retryable: false,
    };
  }

  const endpointKey = cfg.minimaxEndpoint === 'io' ? 'io' : 'cn';
  const url = ENDPOINTS[endpointKey];
  const model = MINIMAX_MODELS.includes(cfg.minimaxModel) ? cfg.minimaxModel : MINIMAX_MODELS[1];
  const voiceId = (typeof cfg.minimaxVoice === 'string' && cfg.minimaxVoice.trim()) || 'female-shaonv';
  const format = AUDIO_FORMATS.includes(cfg.minimaxFormat) ? cfg.minimaxFormat : 'wav';

  const body = {
    model,
    text,
    stream: false,
    output_format: 'hex',
    language_boost: cfg.minimaxLanguageBoost || 'auto',
    voice_setting: {
      voice_id: voiceId,
      speed: clamp(cfg.minimaxSpeed, 0.5, 2, 1),
      vol: clamp(cfg.minimaxVolume, 0.1, 10, 1),
      pitch: clamp(cfg.minimaxPitch, -12, 12, 0),
    },
    audio_setting: {
      sample_rate: clamp(cfg.minimaxSampleRate, 8000, 44100, 32000),
      format,
      channel: 1,
    },
  };
  if (cfg.minimaxEmotion && EMOTIONS.includes(cfg.minimaxEmotion)) {
    body.voice_setting.emotion = cfg.minimaxEmotion;
  }

  const groupId = resolveGroupId(cfg, opts).groupId;
  const withQuery = groupId ? `${url}?GroupId=${encodeURIComponent(groupId)}` : url;

  const timeoutMs = clamp(cfg.minimaxTimeoutMs, 2000, 120_000, DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let response;
  try {
    response = await fetch(withQuery, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, code: 'network', error: describeFailure(err, [key]), retryable: true };
  }
  clearTimeout(timer);

  let payload;
  const raw = await response.text().catch(() => '');
  try {
    payload = JSON.parse(raw);
  } catch {
    const snippet = redact(raw.slice(0, 200), [key]);
    return {
      ok: false,
      code: `http-${response.status}`,
      error: `返回不是 JSON（HTTP ${response.status}）：${snippet}`,
      retryable: response.status >= 500,
    };
  }

  const statusCode = payload?.base_resp?.status_code;
  if (statusCode !== 0 && statusCode !== undefined) {
    const statusMsg = redact(payload?.base_resp?.status_msg ?? '', [key]);
    const retryable = [1001, 1002, 1039].includes(Number(statusCode));
    return { ok: false, code: `mini-${statusCode}`, error: describeStatus(statusCode, statusMsg), retryable };
  }
  if (!response.ok) {
    return { ok: false, code: `http-${response.status}`, error: `HTTP ${response.status}`, retryable: response.status >= 500 };
  }
  if (!payload?.data || typeof payload.data.audio !== 'string' || !payload.data.audio) {
    return { ok: false, code: 'empty-audio', error: '返回里没有音频数据（data.audio 为空）', retryable: true };
  }

  let bytes;
  try {
    bytes = Buffer.from(payload.data.audio, 'hex');
  } catch (err) {
    return { ok: false, code: 'bad-hex', error: `音频解码失败：${redact(err?.message ?? err, [key])}`, retryable: false };
  }
  if (!bytes.length) return { ok: false, code: 'empty-audio', error: '音频解码后长度为 0', retryable: true };

  const info = payload.extra_info ?? {};
  return {
    ok: true,
    bytes,
    ms: Date.now() - started,
    model,
    voiceId,
    keyFrom: from,
    traceId: payload.trace_id,
    usage: {
      characters: info.usage_characters ?? null,
      audioMs: info.audio_length ?? null,
      audioFormat: info.audio_format ?? format,
      sampleRate: info.audio_sample_rate ?? null,
    },
  };
}
