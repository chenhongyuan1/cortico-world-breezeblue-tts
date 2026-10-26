/**
 * 这个 World 的配置段（config.json 里的 worlds.breezeblue-tts）。
 *
 * 默认 enabled: false —— 按需求默认关，装上不改变任何行为。所有字段都在每次用到时现读
 * ctx.cfg（它是活引用），所以改 config.json 或 WebUI 里的值立刻生效，不必重启。
 *
 * 密钥不在这里定义默认值：key 由 src/secrets.js 从环境变量或部署目录的 .env 读，
 * 绝不写死在代码里。
 */

/** 取整并夹在 lo..hi；不是数字时用 dflt。 */
export function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

/** 取浮点并夹在 lo..hi。 */
export function clampFloat(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/** 系统语音的语速：-10..10（System.Speech 的 Rate 就是这一档）。 */
export const normalizeRate = (v) => clampInt(v, -10, 10, 0);

/** 系统语音的音量 0..100。 */
export const normalizeVolume = (v) => clampInt(v, 0, 100, 100);

/** 一次最多排几句；说不过来就丢新来的，免得越念越落后。 */
export const QUEUE_MAX = 4;

/** 排队超过这么久还没轮到就丢掉（毫秒）。要大于云端超时，否则网络慢时会全被丢掉。 */
export const STALE_MS = 25_000;

/** 两句完全一样且间隔很短时只念一次（毫秒）。 */
export const DEDUPE_MS = 2_000;

/** 单句发给云端/系统语音的文字上限，防止请求体或命令行参数过长。 */
export const TEXT_MAX = 500;
