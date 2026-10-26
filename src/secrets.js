/**
 * 密钥读取与脱敏。
 *
 * 需求：key 只从配置或环境变量来，绝不写死在代码里，也不要问用户要。
 *
 * 查找顺序（先找到先用）：
 *   1. config.json 的 worlds.breezeblue-tts.minimaxApiKey（如果真填在那里；明文，仅作兜底）
 *   2. 环境变量（默认依次看 MINIMAX_API_KEY、MINIMAX_KEY、MINIMAX_TTS_API_KEY，
 *      可用 minimaxApiKeyEnv 指定一个名字）
 *   3. 部署目录下的 .env（Coopanion 自己的密钥文件；框架的 ctx.secret() 就是读它）
 *   4. 进程环境里 CORTICO_HOME 指向的 .env（多一层保险）
 *
 * 任何路径都不写盘、不打印。日志与错误信息一律先过 redact()，避免 key 漏进 log.jsonl。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 默认按顺序尝试的环境变量名。 */
export const DEFAULT_KEY_ENVS = ['MINIMAX_API_KEY', 'MINIMAX_KEY', 'MINIMAX_TTS_API_KEY'];
export const BREEZE_KEY_ENVS = ['BREEZE_API_KEY', 'BREEZEBLUE_API_KEY', 'BREEZE_BLUE_API_KEY'];

/** Breeze credentials are resolved separately; a MiniMax key is never sent to Breeze. */
export function resolveBreezeApiKey(cfg = {}, opts = {}) {
  const names = [...new Set([cfg.breezeApiKeyEnv, ...BREEZE_KEY_ENVS]
    .filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^(brz_|sk-)/i.test(name)))];
  const tried = [];
  if (typeof cfg.breezeApiKey === 'string' && cfg.breezeApiKey.trim()) {
    return { key: cfg.breezeApiKey.trim(), from: 'config', tried };
  }
  for (const name of names) {
    tried.push(`env:${name}`);
    const key = process.env[name]?.trim();
    if (key) return { key, from: `env:${name}`, tried };
  }
  for (const file of envFileCandidates(opts)) {
    tried.push(file);
    const values = readEnvFile(file);
    for (const name of names) {
      const key = values.get(name)?.trim();
      if (key) return { key, from: `.env:${name}`, tried };
    }
  }
  return { key: '', from: '', tried };
}

/** 解析 .env：`NAME=value`，取第一个非空值；忽略 `export ` 前缀与两侧引号。 */
export function readEnvFile(file) {
  const out = new Map();
  if (!file || !existsSync(file)) return out;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value && !out.has(m[1])) out.set(m[1], value);
  }
  return out;
}

/** 候选 .env 位置：部署目录、CORTICO_HOME、程序目录旁的 data\home\*。 */
function envFileCandidates(opts = {}) {
  const files = [];
  const push = (dir) => {
    if (dir) files.push(join(resolve(dir), '.env'));
  };
  push(opts.botDir);
  push(opts.dataDir);
  push(process.env.CORTICO_HOME);
  if (process.env.CORTICO_COMPANION_DATA) {
    push(join(resolve(process.env.CORTICO_COMPANION_DATA), 'home', 'companion'));
  }
  if (typeof process.execPath === 'string') push(join(resolve(process.execPath, '..'), 'data', 'home', 'companion'));
  return [...new Set(files)];
}

/**
 * 取 MiniMax 的 key。返回 { key, from }，没找到时 key 为空串、from 说明找过哪里。
 *
 * cfg 用到的字段：minimaxApiKey、minimaxApiKeyEnv；opts 提供 botDir/dataDir（部署目录）。
 */
export function resolveApiKey(cfg = {}, opts = {}) {
  const tried = [];
  const pick = (v) => (typeof v === 'string' ? v.trim() : '');

  const fromConfig = pick(cfg.minimaxApiKey);
  if (fromConfig) return { key: fromConfig, from: 'config', tried };

  const names = [];
  const named = pick(cfg.minimaxApiKeyEnv);
  if (named) names.push(named);
  for (const n of DEFAULT_KEY_ENVS) if (!names.includes(n)) names.push(n);

  for (const name of names) {
    tried.push(`env:${name}`);
    const value = pick(process.env[name]);
    if (value) return { key: value, from: `env:${name}`, tried };
  }

  for (const file of envFileCandidates(opts)) {
    tried.push(file);
    const vars = readEnvFile(file);
    for (const name of names) {
      const value = pick(vars.get(name));
      if (value) return { key: value, from: `.env:${name}`, file, tried };
    }
  }

  return { key: '', from: '', tried };
}

/** 可选：GroupId 只在个别旧接口需要，t2a_v2 用不上，但允许填。 */
export function resolveGroupId(cfg = {}, opts = {}) {
  const pick = (v) => (typeof v === 'string' ? v.trim() : '');
  const direct = pick(cfg.minimaxGroupId);
  if (direct) return { groupId: direct, from: 'config' };
  for (const name of ['MINIMAX_GROUP_ID', 'MINIMAX_GROUPID']) {
    const value = pick(process.env[name]);
    if (value) return { groupId: value, from: `env:${name}` };
  }
  for (const file of envFileCandidates(opts)) {
    const vars = readEnvFile(file);
    for (const name of ['MINIMAX_GROUP_ID', 'MINIMAX_GROUPID']) {
      const value = pick(vars.get(name));
      if (value) return { groupId: value, from: `.env:${name}` };
    }
  }
  return { groupId: '', from: '' };
}

/** 把 key 从任何要落日志/写错误的字符串里抹掉。 */
export function redact(text, secrets = []) {
  let out = typeof text === 'string' ? text : String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 6) continue;
    out = out.split(secret).join('***');
  }
  // Authorization 头就算 key 未知也不该出现在日志里
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***');
  out = out.replace(/brz_[A-Za-z0-9._~+/=-]+/g, 'brz_***');
  out = out.replace(/(xi-api-key\s*[:=]\s*)[^\s,;"'}]+/gi, '$1***');
  return out;
}
