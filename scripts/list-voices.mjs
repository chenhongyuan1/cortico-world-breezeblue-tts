/**
 * 列出这台机器上的语音音色，用来挑一个填进「音色」配置。
 *
 *   node scripts/list-voices.mjs
 *
 * 名字可以只写一部分：扩展按"完全相等 → 包含 → 第一个可用"的顺序挑音色，
 * 所以填 Huihui 就能选中 Microsoft Huihui Desktop。
 */
import { listVoices } from '../src/tts.js';

const res = await listVoices();
if (!res.ok) {
  console.error('没有可用的语音引擎：', res.error ?? '未知原因');
  console.error('Windows 上可以检查：设置 → 时间和语言 → 语音 → 管理语音（安装中文语音包）。');
  process.exit(1);
}

console.log(`这台机器上有 ${res.voices.length} 个音色：\n`);
const byEngine = new Map();
for (const v of res.voices) {
  const key = v.engine || 'unknown';
  if (!byEngine.has(key)) byEngine.set(key, []);
  byEngine.get(key).push(v);
}
for (const [engine, list] of byEngine) {
  console.log(`[${engine}]`);
  for (const v of list) console.log(`  ${v.name}${v.culture ? `   (${v.culture})` : ''}`);
  console.log('');
}

const zh = res.voices.filter((v) => /zh|chinese|huihui|kangkang|yaoyao/i.test(`${v.culture} ${v.name}`));
console.log(zh.length
  ? `中文音色 ${zh.length} 个，推荐在控制台里把「音色」填成：${zh[0].name}`
  : '没找到中文音色：中文会用英文嗓子念。可在 设置 → 时间和语言 → 语音 里添加中文语音包。');
