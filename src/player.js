/**
 * 把一段 WAV 字节放出来。
 *
 * 云端 TTS 返回的是音频字节；Windows 上用它自带的 Media.SoundPlayer 播放最省事：
 * 每次起一个 PowerShell 进程播完就退，不需要常驻播放器，也没有额外依赖。
 *
 * 这里自己解析 WAV 头，而不是把采样率写死：MiniMax 的采样率是可配的，万一实际值和请求
 * 不一致，用错误采样率播出来会变调。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 播放脚本在包内 scripts/ 下。 */
export const PLAY_SCRIPT = join(HERE, '..', 'scripts', 'play-wav.ps1');

const PS_EXE = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

/** 从 RIFF 头里读出时长与格式；读不出来就返回 null（调用方按未知时长处理）。 */
export function wavInfo(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44) return null;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
  // 在块里找 fmt 与 data，不假设它们紧跟固定偏移
  let offset = 12;
  let fmt = null;
  let dataSize = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      fmt = {
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bitsPerSample: bytes.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataSize = Math.min(size, Math.max(0, bytes.length - body));
    }
    offset = body + size + (size % 2); // 块按偶数字节对齐
    if (size <= 0) break;
  }
  if (!fmt || dataSize === null) return null;
  const bytesPerFrame = (Math.max(8, fmt.bitsPerSample) / 8) * Math.max(1, fmt.channels);
  // 帧数 ÷ 采样率才是秒。少除这一下会把 0.6 秒算成 19200 "毫秒"（踩过的坑）。
  const frames = bytesPerFrame > 0 ? dataSize / bytesPerFrame : 0;
  const ms = fmt.sampleRate > 0 ? Math.round((frames / fmt.sampleRate) * 1000) : 0;
  return {
    ...fmt,
    dataSize,
    frames: Math.round(frames),
    bytesPerFrame,
    ms,
  };
}

/** 起一个进程，等它退出；超时则杀掉。 */
function runProcess(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(PS_EXE, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stderr: String(err?.message ?? err) });
      return;
    }
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
      finish({ code: -1, stderr: `${stderr}\ntimeout` , timeout: true });
    }, timeoutMs);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish({ code: -1, stderr: `${stderr}\n${err.message}`, error: err }));
    child.on('close', (code) => finish({ code, stderr }));
  });
}

/**
 * 播放一段 WAV。返回 { ok, ms, error }。
 *
 * 两段时间要分清，这是踩过的坑：
 *   - 脚本内的播放上限（playTimeoutSec）是"声音放多久"的权威，脚本到点自己 Stop 并 exit 0；
 *   - 这里的进程级等待只是**兜底**，必须比它宽：冷启动一个 powershell.exe 就要 1 秒以上
 *     （本机实测约 1.2s），所以等待 = 播放上限 + 启动余量 + 尾巴，不然会误杀正常播放。
 *
 * 临时文件写在系统临时目录，播完（或失败）一定删掉；删除失败也不影响结果。
 */
export async function playWav(bytes, cfg = {}) {
  const info = wavInfo(bytes);
  if (!info) return { ok: false, ms: 0, error: '返回的不是合法 WAV（云端音频格式要对上，audioFormat 配置）' };

  const dir = await mkdtemp(join(tmpdir(), 'breezeblue-tts-'));
  const file = join(dir, 'line.wav');
  try {
    await writeFile(file, bytes);
    // 脚本内：一句最多放多久（同时也是它最长等待的时间）
    const capMs = Math.max(3000, Math.ceil(Math.max(1, cfg.playTimeoutSec ?? 60)) * 1000);
    // 进程级兜底：脚本上限 + 4 秒（PowerShell 启动 + 文件 IO + 退出）
    const waitMs = capMs + 4000;
    const res = await runProcess([
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', PLAY_SCRIPT,
      '-File', file,
      '-TimeoutMs', String(capMs),
    ], waitMs);
    if (res.code !== 0) {
      const why = (res.stderr || '').trim().split('\n').pop() || `exit ${res.code}`;
      return { ok: false, ms: info.ms, error: why };
    }
    return { ok: true, ms: info.ms, sampleRate: info.sampleRate, channels: info.channels };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 探一下这台机器能不能播（只看类型和脚本在不在，不放声音）。 */
export async function probePlayer() {
  const dir = await mkdtemp(join(tmpdir(), 'breezeblue-tts-probe-'));
  const file = join(dir, 'silence.wav');
  try {
    // 0.1 秒 8kHz 单声道静音 WAV
    const samples = 800;
    const data = Buffer.alloc(samples * 2);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(16000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(data.length, 40);
    await writeFile(file, Buffer.concat([header, data]));
    const res = await runProcess([
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', PLAY_SCRIPT, '-File', file, '-DryRun',
    ], 20_000);
    if (res.code !== 0) {
      const why = (res.stderr || '').trim().split('\n').pop() || `exit ${res.code}`;
      return { ok: false, error: why };
    }
    return { ok: true };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
