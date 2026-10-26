/**
 * 密钥读取测试：用真实的 .env 文件验证优先级与解析细节。
 *
 *   node scripts/test-secrets.mjs
 *
 * 覆盖：
 *   - .env 里的值能被读到；
 *   - 环境变量优先于 .env；
 *   - config 里的字段优先级最高；
 *   - .env 的常见写法都能解析（注释、export 前缀、引号、CRLF）；
 *   - .env 里没有该变量时不会误取别的变量；
 *   - minimaxApiKeyEnv 能指定自定义变量名；
 *   - 脱敏：key 与 Bearer 头都不会漏进日志文本。
 *
 * 只在工作目录下造一个临时目录，用完删掉；不碰真实的 Coopanion 目录，也不联网。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolveApiKey, readEnvFile, redact, DEFAULT_KEY_ENVS } from '../src/secrets.js';

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${label}${detail ? `\n         ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const root = join(process.cwd(), '_secrets-test');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const KEY_FILE = 'sk-from-dotenv-file-0123456789';
const KEY_ENV = 'sk-from-process-env-9876543210';
const saved = process.env.MINIMAX_API_KEY;
const savedOwn = process.env.MY_OWN_MINIMAX;

try {
  // 1) 只有 .env
  writeFileSync(join(root, '.env'), `# comment\nOTHER=xxx\nMINIMAX_API_KEY=${KEY_FILE}\n`, 'utf8');
  delete process.env.MINIMAX_API_KEY;
  let r = resolveApiKey({}, { botDir: root });
  check(r.key === KEY_FILE && r.from === '.env:MINIMAX_API_KEY',
    '.env 里的 key 能被读到（这是推荐填法）', `from=${r.from}`);

  // 2) 环境变量优先于 .env
  process.env.MINIMAX_API_KEY = KEY_ENV;
  r = resolveApiKey({}, { botDir: root });
  check(r.key === KEY_ENV && r.from === 'env:MINIMAX_API_KEY',
    '环境变量优先于 .env', `from=${r.from}`);

  // 3) config 字段优先级最高
  r = resolveApiKey({ minimaxApiKey: 'sk-from-config-field-5555555555' }, { botDir: root });
  check(r.from === 'config', 'config 里的 key 优先级最高', `from=${r.from}`);

  // 4) .env 的各种写法
  writeFileSync(join(root, '.env'), 'export MINIMAX_API_KEY="sk-quoted-and-export-0001"\r\n', 'utf8');
  delete process.env.MINIMAX_API_KEY;
  r = resolveApiKey({}, { botDir: root });
  check(r.key === 'sk-quoted-and-export-0001',
    '.env 支持 export 前缀、引号与 CRLF', `读到 ${JSON.stringify(r.key)}`);

  // 5) .env 里没有该变量时不误取别的
  writeFileSync(join(root, '.env'), 'SOMETHING_ELSE=sk-not-ours-000000000000\n', 'utf8');
  r = resolveApiKey({}, { botDir: root });
  const parsed = [...readEnvFile(join(root, '.env')).keys()];
  check(r.key === '', '.env 里没有目标变量时正确地不返回任何 key',
    `解析出的变量：${parsed.join(',') || '(空)'}`);

  // 6) 自定义环境变量名
  process.env.MY_OWN_MINIMAX = 'sk-custom-name-target-7777777777';
  r = resolveApiKey({ minimaxApiKeyEnv: 'MY_OWN_MINIMAX' }, {});
  check(r.key === 'sk-custom-name-target-7777777777' && r.from === 'env:MY_OWN_MINIMAX',
    'minimaxApiKeyEnv 能指定自定义变量名', `from=${r.from}`);

  // 7) 默认候选名字就是文档里写的那三个
  r = resolveApiKey({}, { botDir: root });
  check(DEFAULT_KEY_ENVS.join(',') === 'MINIMAX_API_KEY,MINIMAX_KEY,MINIMAX_TTS_API_KEY',
    '默认候选环境变量名与文档一致', DEFAULT_KEY_ENVS.join(', '));

  // 8) 脱敏
  check(!redact(`Authorization: Bearer ${KEY_FILE}`, [KEY_FILE]).includes(KEY_FILE),
    '知道 key 值时会被抹成 ***');
  check(!/abcdefghijklmnop/.test(redact('Bearer abcdefghijklmnopqrst', [])),
    '不知道 key 值时，Bearer 头也会被抹掉');
  check(redact('短字符串不受影响', ['abc']) === '短字符串不受影响',
    '太短的值不参与替换（避免把正常文本打花）');
} finally {
  if (saved === undefined) delete process.env.MINIMAX_API_KEY; else process.env.MINIMAX_API_KEY = saved;
  if (savedOwn === undefined) delete process.env.MY_OWN_MINIMAX; else process.env.MY_OWN_MINIMAX = savedOwn;
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项未通过`}`);
process.exit(failed === 0 ? 0 : 1);
