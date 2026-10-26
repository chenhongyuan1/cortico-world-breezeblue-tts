/**
 * 只发一条最小的 MiniMax 请求，验证 key / 网络 / 模型 / 音色能不能用。
 *
 *   node scripts/minimax-probe.mjs                    # 用默认站点与默认音色，念两个字
 *   node scripts/minimax-probe.mjs --text "你好呀"     # 换一句话
 *   node scripts/minimax-probe.mjs --voice female-tianmei --model speech-2.8-hd
 *   node scripts/minimax-probe.mjs --endpoint io      # 国际站
 *   node scripts/minimax-probe.mjs --play             # 顺便放出来听（Windows）
 *   node scripts/minimax-probe.mjs --key-from-env MY_MINIMAX_KEY
 *
 * 会消耗极少量额度（默认两个字）。key 不会打印出来，只报来源。
 * 不发请求也能先看配置：加 --dry-run（只检查 key 与参数，不联网）。
 * 只想知道网络通不通：加 --net（发一个故意的坏 key，预期拿回 1004，不消耗额度）。
 */
import { resolveApiKey, redact } from '../src/secrets.js';
import { synthesizeMiniMax, MINIMAX_MODELS, CHINESE_VOICES, ENDPOINTS } from '../src/cloud.js';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const value = (n, d = '') => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const cfg = {
  minimaxEndpoint: value('--endpoint', 'cn') === 'io' ? 'io' : 'cn',
  minimaxModel: value('--model', 'speech-2.8-turbo'),
  minimaxVoice: value('--voice', 'female-shaonv'),
  minimaxSpeed: Number(value('--speed', '1')) || 1,
  minimaxVolume: Number(value('--volume', '1')) || 1,
  minimaxPitch: Number(value('--pitch', '0')) || 0,
  minimaxEmotion: value('--emotion', ''),
  minimaxSampleRate: '32000',
  minimaxFormat: 'wav',
  minimaxTimeoutMs: Number(value('--timeout', '20000')) || 20000,
  minimaxApiKeyEnv: value('--key-from-env', ''),
  minimaxGroupId: value('--group-id', ''),
};

const text = value('--text', '\u4f60\u597d');

// --data 交给密钥查找：这样会去找那个部署目录下的 .env（不指定就只能靠环境变量）
const botDir = value('--data', '');
const where = botDir ? { botDir, dataDir: botDir } : {};
const apiKey = resolveApiKey(cfg, where);

console.log('=== 配置 ===');
console.log(`  站点      ${cfg.minimaxEndpoint}  ${ENDPOINTS[cfg.minimaxEndpoint]}`);
console.log(`  模型      ${cfg.minimaxModel}${MINIMAX_MODELS.includes(cfg.minimaxModel) ? '' : '  ← 不在官方清单里，请核对'}`);
console.log(`  音色      ${cfg.minimaxVoice}${CHINESE_VOICES.some((v) => v.id === cfg.minimaxVoice) ? '' : '  （不在内置中文表里；可能是复刻/自建音色）'}`);
console.log(`  语速/音量/音调  ${cfg.minimaxSpeed} / ${cfg.minimaxVolume} / ${cfg.minimaxPitch}`);
console.log(`  要念的字  ${JSON.stringify(text)}（${[...text].length} 字符）`);
console.log(`  key 来源  ${apiKey.from || '（没找到）'}`);
console.log(`  找过      ${apiKey.tried.join('、')}`);

// 只测网络与端点：用一个故意的坏 key，预期服务端回 1004（鉴权失败）。
// 拿回 1004 说明"能连上、端点对、鉴权头形状对"；这样不消耗任何额度。
if (flag('--net')) {
  const bad = await synthesizeMiniMax(text, { ...cfg, minimaxApiKey: 'invalid-probe-key', minimaxTimeoutMs: 15000 }, {});
  const reachable = bad.code === 'mini-1004';
  console.log(reachable
    ? `\n网络与端点正常：${ENDPOINTS[cfg.minimaxEndpoint]} 可达，鉴权头形状正确（服务端回了预期的 1004）`
    : `\n连通性检查没得到预期结果：${bad.code ?? '?'} ${redact(bad.error ?? '', [])}`);
  process.exit(reachable ? 0 : 1);
}

if (!apiKey.key) {
  console.error('\n没找到 key。把它写进部署目录的 .env：');
  console.error('  MINIMAX_API_KEY=你的key');
  console.error(`（本次找过的位置见上面一行；也可以先用 --key-from-env <环境变量名> 指定）`);
  process.exit(1);
}

if (flag('--dry-run')) {
  console.log('\n（--dry-run：只检查配置，没有联网）');
  process.exit(0);
}

console.log('\n=== 请求 ===');
const res = await synthesizeMiniMax(text, cfg, where);
if (!res.ok) {
  console.error(`失败：${redact(res.error, [apiKey.key])}`);
  if (res.code) console.error(`错误码：${res.code}${res.retryable ? '（可重试）' : ''}`);
  if (String(res.code).endsWith('1004')) {
    console.error('提示：key 不对，或 key 与站点不是同一家（国内 key 要配 cn，国际 key 要配 io）。');
  }
  process.exit(1);
}

console.log(`  HTTP 成功，耗时 ${res.ms}ms`);
console.log(`  音频 ${res.bytes.length} 字节，格式 ${res.usage?.audioFormat ?? 'wav'}，采样率 ${res.usage?.sampleRate ?? '?'}`);
console.log(`  时长 ${res.usage?.audioMs ?? '?'}ms，计费字符 ${res.usage?.characters ?? '?'}`);
console.log(`  trace_id ${res.traceId ?? '(无)'}`);

if (flag('--play')) {
  const { playWav } = await import('../src/player.js');
  const played = await playWav(res.bytes, cfg);
  console.log(played.ok ? `  已播放（${played.ms}ms，${played.sampleRate}Hz）` : `  播放失败：${played.error}`);
  if (!played.ok) process.exit(1);
} else {
  console.log('\n（加 --play 可以顺便放出来听）');
}
