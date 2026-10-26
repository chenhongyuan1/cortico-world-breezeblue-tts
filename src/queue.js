/**
 * 串行朗读队列。
 *
 * 桌宠的气泡一段一段冒出来，可能连着来好几句；同时出声会互相抢音、听起来是乱的。
 * 所以排队一次念一句（speaker.speak 由 speech.js 提供，可能是云端，也可能是系统语音）。
 *
 * 三条自保规则：
 *   - 队列最多 QUEUE_MAX 句，满了丢新来的——宁可漏一句，也不要越念越落后；
 *   - 排队超过 STALE_MS 的丢掉——气泡早没了，念出来只会莫名其妙；
 *   - 与上一句完全相同且间隔不到 DEDUPE_MS 的丢掉。
 *
 * 云端超时不会堵住后面：speak() 自带超时，最坏情况只是这句慢/没声，队列照常前进。
 */
import { QUEUE_MAX, STALE_MS, DEDUPE_MS } from './config.js';

/**
 * @param speak    (text) => Promise<{ ok, engine, ms, error?, fellBack? }>，来自 createSpeech()
 * @param onEvent  每组结果回调一次，给日志/面板用
 */
export function createSpeaker({ speak, onEvent = () => {} } = {}) {
  /** @type {Array<{ text: string, enqueuedAt: number }>} */
  const queue = [];
  let running = false;
  let stopped = false;
  let lastText = '';
  let lastAt = 0;
  const stats = {
    spoken: 0, dropped: 0, failed: 0, queued: 0, busy: false,
    lastError: '', lastVoice: '', lastEngine: '', lastModel: '',
    fellBack: 0, cloudSpoken: 0, sapiSpoken: 0, lastAt: 0,
  };

  async function worker() {
    if (running) return;
    running = true;
    try {
      while (queue.length && !stopped) {
        const item = queue.shift();
        stats.queued = queue.length;
        const waited = Date.now() - item.enqueuedAt;
        if (waited > STALE_MS) {
          stats.dropped += 1;
          onEvent({ kind: 'dropped', reason: 'stale', text: item.text, waitedMs: waited });
          continue;
        }
        stats.busy = true;
        let res;
        try {
          res = await speak(item.text);
        } catch (err) {
          // speak() 自己不该抛；真抛了也不能让队列死掉
          res = { ok: false, error: err?.message ?? String(err), engine: 'none' };
        }
        stats.busy = false;
        stats.lastAt = Date.now();

        if (res?.ok) {
          stats.spoken += 1;
          if (['minimax', 'breeze'].includes(res.engine)) stats.cloudSpoken += 1;
          if (res.engine === 'sapi') stats.sapiSpoken += 1;
          if (res.fellBack) stats.fellBack += 1;
          if (res.voice) stats.lastVoice = res.voice;
          if (res.engine) stats.lastEngine = res.engine;
          if (res.model) stats.lastModel = res.model;
          onEvent({ kind: 'spoken', text: item.text, ...res });
        } else {
          stats.failed += 1;
          stats.lastError = res?.error ?? 'unknown';
          onEvent({ kind: 'failed', text: item.text, error: stats.lastError, engine: res?.engine });
        }
      }
    } finally {
      running = false;
      stats.busy = false;
    }
  }

  return {
    /** 排一句。返回 'queued' | 'deduped' | 'full' | 'stopped' | 'empty'。 */
    say(text) {
      const line = typeof text === 'string' ? text.trim() : '';
      if (!line) return 'empty';
      if (stopped) return 'stopped';
      const now = Date.now();
      if (line === lastText && now - lastAt < DEDUPE_MS) return 'deduped';
      if (queue.length >= QUEUE_MAX) {
        stats.dropped += 1;
        onEvent({ kind: 'dropped', reason: 'full', text: line });
        return 'full';
      }
      lastText = line;
      lastAt = now;
      queue.push({ text: line, enqueuedAt: now });
      stats.queued = queue.length;
      void worker();
      return 'queued';
    },
    stats: () => ({ ...stats, queued: queue.length }),
    /** 停掉：清空队列、不再接新的；在飞的那一句让它自己结束。 */
    stop() {
      stopped = true;
      queue.length = 0;
      stats.queued = 0;
    },
  };
}
