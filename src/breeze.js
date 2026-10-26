/** Breeze Blue synchronous TTS: xi-api-key authentication and binary WAV response.
 * https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech
 */
import { resolveBreezeApiKey, redact, BREEZE_KEY_ENVS } from './secrets.js';
import { wavInfo } from './player.js';
import { clampInt, clampFloat } from './config.js';

// Keep the credential destination fixed to the documented service.
export const BREEZE_BASE_URL = 'https://api.breeze.blue/v1';
export const BREEZE_DEFAULT_MODEL = 'breeze-tts-2';

export function breezeKeyStatus(cfg = {}, opts = {}) {
  const result = resolveBreezeApiKey(cfg, opts);
  return { configured: Boolean(result.key), from: result.from || null, candidates: BREEZE_KEY_ENVS };
}

/** Timeout includes downloading the response body, not only receiving headers. */
async function request(path, init, cfg, opts, decode) {
  const { key, from } = resolveBreezeApiKey(cfg, opts);
  if (!key) return { ok: false, code: 'no-key', error: '未配置 BreezeBlue API key（BREEZE_API_KEY）', retryable: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clampInt(cfg.breezeTimeoutMs, 2000, 120000, 15000));
  try {
    const response = await fetch(`${BREEZE_BASE_URL}${path}`, {
      ...init,
      headers: { ...init.headers, 'xi-api-key': key },
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      const raw = await response.text();
      let payload;
      try { payload = JSON.parse(raw); } catch { /* HTML gateway error */ }
      const detail = payload?.detail ?? payload?.error ?? raw.slice(0, 200);
      return {
        ok: false,
        code: payload?.code || `http-${response.status}`,
        error: redact(`BreezeBlue HTTP ${response.status}：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, [key]),
        retryable: [408, 429].includes(response.status) || response.status >= 500,
      };
    }
    if (response.status === 202) {
      await response.body?.cancel();
      return { ok: false, code: 'pending-job', error: 'BreezeBlue 尚在后台生成，本句回退系统语音；可缩短单句文字或稍后再试', retryable: true };
    }
    return { ...await decode(response), keyFrom: from };
  } catch (err) {
    const timedOut = controller.signal.aborted;
    return {
      ok: false, code: timedOut ? 'timeout' : 'network', retryable: true,
      error: timedOut ? 'BreezeBlue 请求超时（含音频下载）' : redact(`BreezeBlue 请求失败：${err?.message ?? err}`, [key]),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function synthesizeBreeze(text, cfg = {}, opts = {}) {
  const voiceId = typeof cfg.breezeVoice === 'string' ? cfg.breezeVoice.trim() : '';
  if (!voiceId) return { ok: false, code: 'no-voice', error: '未配置 BreezeBlue 音色 ID；请填写 breezeVoice', retryable: false };
  if (typeof text !== 'string' || !text.trim()) return { ok: false, code: 'empty-text', error: '朗读文字为空', retryable: false };
  const model = typeof cfg.breezeModel === 'string' ? cfg.breezeModel.trim() : BREEZE_DEFAULT_MODEL;
  const language = typeof cfg.breezeLanguageCode === 'string' ? cfg.breezeLanguageCode.trim() : '';
  if (language && !/^[A-Za-z]{2}$/.test(language)) {
    return { ok: false, code: 'bad-language', error: 'BreezeBlue 语言代码应为两位字母，例如 zh、en；留空自动识别', retryable: false };
  }
  const body = {
    text,
    voice_settings: {
      speed: clampFloat(cfg.breezeSpeed, 0.5, 2, 1),
      volume: clampFloat(cfg.breezeVolume, 0.01, 2, 1),
      guidance_scale: clampFloat(cfg.breezeGuidanceScale, 1, 10, 1),
      use_speaker_boost: cfg.breezeSpeakerBoost === true,
    },
  };
  if (model) body.model_id = model;
  if (language) body.language_code = language.toLowerCase();
  if (typeof cfg.breezeInstructions === 'string' && cfg.breezeInstructions.trim()) {
    body.instructions = cfg.breezeInstructions.trim();
  }
  const started = Date.now();
  return request(`/text-to-speech/${encodeURIComponent(voiceId)}?output_format=wav&delivery=sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' },
    body: JSON.stringify(body),
  }, cfg, opts, async (response) => {
    const bytes = Buffer.from(await response.arrayBuffer());
    const info = wavInfo(bytes);
    if (!info || !info.dataSize || !info.sampleRate || !info.channels) {
      return { ok: false, code: 'invalid-audio', error: 'BreezeBlue 未返回可播放的 WAV 音频', retryable: false };
    }
    return {
      ok: true, bytes, ms: Date.now() - started, model: model || 'auto', voiceId,
      traceId: response.headers.get('x-request-id') || undefined,
      usage: { characters: null, audioMs: info.ms, audioFormat: 'wav', sampleRate: info.sampleRate },
    };
  });
}

/** Read-only, no speech generation charge. Returns one page, including pagination token. */
export async function listBreezeVoices(cfg = {}, opts = {}, { pageToken = '', language = '' } = {}) {
  const query = new URLSearchParams({ page_size: '100' });
  if (pageToken) query.set('next_page_token', pageToken);
  if (language) query.set('language_code', language);
  return request(`/voices?${query}`, { method: 'GET' }, cfg, opts, async (response) => {
    const payload = await response.json();
    if (!Array.isArray(payload?.voices)) return { ok: false, code: 'bad-voices', error: 'BreezeBlue 音色列表格式不正确' };
    return { ok: true, voices: payload.voices, nextPageToken: payload.next_page_token || null, hasMore: payload.has_more === true };
  });
}
