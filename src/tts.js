/**
 * 两个合成引擎的原语：系统自带（Windows SAPI / System.Speech）与 MiniMax 云端。
 *
 * 这里只做"文字 → 声音"或"文字 → 音频字节"，不管排队、不管回退策略（那是 speech.js）。
 * 每次调用起一个 PowerShell 子进程，念完/播完就退：不必维护常驻合成器，某一句失败也只
 * 影响那一句，不会把后面的全卡死。
 *
 * 子进程 stdout/stderr 走管道，所以扩展要跑在允许管道 stdio 的进程里（Coopanion 的 Core
 * 是普通 node 子进程，没问题；受限沙箱里会 EPERM，那时会在回执里报出来，不会静默）。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeRate, normalizeVolume, TEXT_MAX } from './config.js';
import { truncate } from './text.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** speak.ps1 在包内 scripts/ 下。 */
export const SPEAK_SCRIPT = join(HERE, '..', 'scripts', 'speak.ps1');

/** 优先用 Windows PowerShell 5.1：System.Speech 在它里面最稳，PATH 里也一定有。 */
const PS_EXE = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

/** 枚举与探测的内联脚本：System.Speech 与 SAPI 5 各报一遍。 */
const LIST_PS = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$out = New-Object System.Collections.ArrayList',
  'try {',
  '  Add-Type -AssemblyName System.Speech',
  '  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '  foreach ($v in $s.GetInstalledVoices()) {',
  '    if ($v.Enabled) { [void]$out.Add([pscustomobject]@{ name = $v.VoiceInfo.Name; culture = $v.VoiceInfo.Culture.Name; engine = "system.speech" }) }',
  '  }',
  '  $s.Dispose()',
  '} catch {}',
  'try {',
  '  $sp = New-Object -ComObject SAPI.SpVoice',
  '  foreach ($t in $sp.GetVoices()) { [void]$out.Add([pscustomobject]@{ name = $t.GetDescription(); culture = ""; engine = "sapi.com" }) }',
  '} catch {}',
  '@($out) | ConvertTo-Json -Compress',
].join('\n');

/** 跑一段 PowerShell，收集 stdout/stderr，给一个超时。 */
export function runPowerShell(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(PS_EXE, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err?.message ?? err), error: err });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退出 */ }
      finish({ code: -1, stdout, stderr: `${stderr}\ntimeout after ${timeoutMs}ms`, timeout: true });
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish({ code: -1, stdout, stderr: `${stderr}\n${err.message}`, error: err }));
    child.on('close', (code) => finish({ code, stdout, stderr, timeout: false }));
  });
}

/**
 * 用系统自带语音念一句（同步等它念完）。
 * 返回 { ok, engine, voice, ms, error }。
 */
export async function speakSapi(text, cfg = {}) {
  const line = truncate(text, TEXT_MAX);
  if (!line) return { ok: true, skipped: 'empty', ms: 0 };
  const started = Date.now();
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', SPEAK_SCRIPT,
    '-Text', line,
    '-Rate', String(normalizeRate(cfg.sapiRate ?? cfg.rate)),
    '-Volume', String(normalizeVolume(cfg.sapiVolume ?? cfg.volume)),
    '-Json',
  ];
  const voice = typeof (cfg.sapiVoice ?? cfg.voice) === 'string' ? String(cfg.sapiVoice ?? cfg.voice).trim() : '';
  if (voice) args.push('-Voice', voice);

  const res = await runPowerShell(args);
  const ms = Date.now() - started;
  if (res.code !== 0) {
    const why = (res.stderr || res.stdout || '').trim().split('\n').pop() || `exit ${res.code}`;
    return { ok: false, ms, error: why };
  }
  let engine;
  let used;
  try {
    const parsed = JSON.parse(res.stdout.trim().split('\n').pop());
    engine = parsed.engine;
    used = parsed.voice;
  } catch { /* 没有 JSON 也算念成功 */ }
  return { ok: true, ms, engine, voice: used };
}

/** 这台机器上有什么系统音色。探测用，不改任何配置。 */
export async function listVoices() {
  const res = await runPowerShell(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', LIST_PS], { timeoutMs: 30_000 });
  if (res.code !== 0 && !res.stdout.trim()) {
    return { ok: false, voices: [], error: (res.stderr || `exit ${res.code}`).trim() };
  }
  try {
    const raw = JSON.parse(res.stdout.trim());
    const voices = (Array.isArray(raw) ? raw : [raw]).filter((v) => v && typeof v.name === 'string');
    return { ok: voices.length > 0, voices };
  } catch (err) {
    return { ok: false, voices: [], error: `解析音色列表失败：${err.message}` };
  }
}
