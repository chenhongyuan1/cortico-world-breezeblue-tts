/**
 * 日志出口。
 *
 * 优先用框架给的 WorldHost.log（挂载后有），其次 WorldContext.logger（构造期就有），
 * 都没有就退回 stderr —— Coopanion 的 Core 是子进程，写 stderr 会进它的输出。
 * 这样"装上但还没激活"这种情况也能留下一句话说清楚，不必去改 Coopanion 本体。
 */

/** 框架的 Logger 用 debug/info/warn/error；这里收敛成四种并加上前缀。 */
const LEVELS = ['debug', 'info', 'warn', 'error'];

/** 自检/测试里设它是为了不往 stderr 写东西，免得污染命令行输出。 */
const silent = () => process.env.PET_VOICE_SILENT === '1';

export function createLog(host, ctx) {
  const prefix = '[breezeblue-tts]';
  return (level, message) => {
    if (silent()) return;
    const lvl = LEVELS.includes(level) ? level : 'info';
    try {
      const viaHost = host?.log?.[lvl];
      if (typeof viaHost === 'function') { viaHost.call(host.log, message); return; }
    } catch { /* 落到下一档 */ }
    try {
      const viaCtx = ctx?.logger?.[lvl];
      if (typeof viaCtx === 'function') { viaCtx.call(ctx.logger, message); return; }
    } catch { /* 落到下一档 */ }
    try {
      process.stderr.write(`${prefix} ${lvl}: ${message}\n`);
    } catch { /* 连 stderr 都写不了就算了 */ }
  };
}
