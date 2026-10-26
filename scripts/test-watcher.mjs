/**
 * 增量读取测试：验证事件监听器在真实文件上的行为。
 *
 * 自检（selftest.mjs）验的是"解析真实事件库"；这里验的是"边写边读"这条容易出错的路：
 *   - 追加的一行要念，且只念一次；
 *   - 一行被分成两次写入时，要等拼完整才念（半行不能当 JSON 解析）；
 *   - 启动时默认不补念已有内容，replayExisting 才补；
 *   - run 换了（index.jsonl 指向新目录）之后跟着换文件，游标去重不会误杀新内容。
 *
 *   node scripts/test-watcher.mjs
 *
 * 只在临时目录里造数据，不碰真实的 Coopanion 目录。
 */
import { mkdirSync, appendFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEventWatcher, currentRunId, currentEventsFile, resolveDataDir } from '../src/events.js';

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${label}${detail ? `\n         ${detail}` : ''}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一份最小可用的 runs 目录：index.jsonl + 一个 run 的 events.jsonl。 */
const root = join(tmpdir(), `petvoice-watcher-${process.pid}`);
const runsDir = join(root, 'runs');
rmSync(root, { recursive: true, force: true });
mkdirSync(runsDir, { recursive: true });

const writeIndex = (runIds) => {
  const body = runIds.flatMap(({ run, startedAt }) => [
    JSON.stringify({ run, startedAt, bot: 'Coo', pid: 1 }),
    JSON.stringify({ run, endedAt: startedAt, lastCursor: 1, complete: true, reason: 'test' }),
  ]).join('\n');
  writeFileSync(join(runsDir, 'index.jsonl'), `${body}\n`, 'utf8');
};

const say = (cursor, text) => JSON.stringify({
  type: 'desktop-pet.self',
  source: 'desktop-pet',
  senderKey: 'desktop-pet.self',
  ts: new Date().toISOString(),
  text,
  meta: { kind: 'say', beats: [{ text }] },
  origin: 'external',
  contextDelivery: 'archive-only',
  cursor,
  run: 'run-1',
});

// ── 准备：run-1 已有一条历史事件 ──────────────────────────────────────────
const run1 = join(runsDir, 'run-1');
mkdirSync(run1, { recursive: true });
writeIndex([{ run: 'run-1', startedAt: new Date().toISOString() }]);
const events1 = join(run1, 'events.jsonl');
writeFileSync(events1, `${say(1, '历史一句话')}\n`, 'utf8');

check(currentRunId(root) === 'run-1', 'currentRunId 读到最近一次 run', String(currentRunId(root)));
check(currentEventsFile(root) === events1, 'currentEventsFile 指向当前 run 的 events.jsonl', String(currentEventsFile(root)));
check(resolveDataDir(root) === root, 'resolveDataDir 认得直接含 runs/ 的目录');

// ── 1. 默认不补念已有内容，只念新追加的 ───────────────────────────────────
const heard = [];
const watcher = createEventWatcher({
  dataDir: root,
  pollMs: 60,
  onText: (text) => heard.push(text),
  onLog: () => {},
});
await watcher.start();
await sleep(150);
check(heard.length === 0, '启动时不补念已有事件（默认）', `听到 ${JSON.stringify(heard)}`);

// 追加一行完整事件
appendFileSync(events1, `${say(2, '第一句新话')}\n`, 'utf8');
await sleep(250);
check(heard.includes('第一句新话'), '追加一行后被念出来', JSON.stringify(heard));

// 再追加一次同样的内容（新游标）：不该被"同文本去重"影响——去重在朗读队列里，不在读取层
appendFileSync(events1, `${say(3, '第一句新话')}\n`, 'utf8');
await sleep(250);
check(heard.filter((t) => t === '第一句新话').length === 2,
  '相同文字但新游标的事件照旧各念一次（去重留给朗读队列）', JSON.stringify(heard));

// 重复读同一份内容不应重复触发（游标去重）
const before = heard.length;
await watcher.poll();
await watcher.poll();
await sleep(120);
check(heard.length === before, '反复轮询不会重复念已读过的行', `before=${before} after=${heard.length}`);

// ── 2. 半行：必须拼完整才念 ──────────────────────────────────────────────
const line = say(4, '被切成两半的一句话');
const cut = Math.floor(line.length / 2);
appendFileSync(events1, line.slice(0, cut), 'utf8');   // 只写前半行，没有换行
await sleep(250);
check(!heard.includes('被切成两半的一句话'), '半行不会被当成完整事件念出来', JSON.stringify(heard));
appendFileSync(events1, `${line.slice(cut)}\n`, 'utf8'); // 补上后半行与换行
await sleep(250);
check(heard.includes('被切成两半的一句话'), '补全后立刻念出来', JSON.stringify(heard));

// ── 3. 多段 beats：一段一条 ─────────────────────────────────────────────
const multi = JSON.stringify({
  type: 'desktop-pet.self', meta: { kind: 'say', beats: [{ text: '第一段' }, { text: '第二段' }] }, cursor: 5,
});
appendFileSync(events1, `${multi}\n`, 'utf8');
await sleep(250);
check(heard.includes('第一段') && heard.includes('第二段'), '一条事件里的两段 beats 各念一次', JSON.stringify(heard.slice(-3)));

// ── 4. 换 run：index.jsonl 指向新目录后跟着换 ─────────────────────────────
const run2 = join(runsDir, 'run-2');
mkdirSync(run2, { recursive: true });
const events2 = join(run2, 'events.jsonl');
writeFileSync(events2, `${say(1, '新 run 的第一句')}\n`, 'utf8');
writeIndex([
  { run: 'run-1', startedAt: new Date(Date.now() - 60_000).toISOString() },
  { run: 'run-2', startedAt: new Date().toISOString() },
]);
await sleep(300);
check(!heard.includes('新 run 的第一句'), '换 run 后的第一句不补念（它写在切换之前）', JSON.stringify(heard.slice(-3)));
appendFileSync(events2, `${say(2, '新 run 里的新话')}\n`, 'utf8');
await sleep(300);
check(heard.includes('新 run 里的新话'), '换 run 之后新追加的照旧念出来', JSON.stringify(heard.slice(-3)));
check(watcher.state().file === events2, 'watcher 已经跟到新 run 的文件', String(watcher.state().file));

watcher.stop();

// ── 5. replayExisting：启动时把已有的补念一遍 ────────────────────────────
const replayRoot = join(tmpdir(), `petvoice-replay-${process.pid}`);
rmSync(replayRoot, { recursive: true, force: true });
mkdirSync(join(replayRoot, 'runs', 'run-r'), { recursive: true });
writeFileSync(join(replayRoot, 'runs', 'index.jsonl'),
  `${JSON.stringify({ run: 'run-r', startedAt: new Date().toISOString() })}\n`, 'utf8');
writeFileSync(join(replayRoot, 'runs', 'run-r', 'events.jsonl'),
  `${say(1, '早就说过的话')}\n${say(2, '也是旧的')}\n`, 'utf8');
const replayHeard = [];
const replayWatcher = createEventWatcher({
  dataDir: replayRoot, pollMs: 60, replayExisting: true,
  onText: (t) => replayHeard.push(t), onLog: () => {},
});
await replayWatcher.start();
await sleep(200);
replayWatcher.stop();
check(replayHeard.includes('早就说过的话') && replayHeard.includes('也是旧的'),
  'replayExisting: true 时把启动前的事件补念一遍', JSON.stringify(replayHeard));

// ── 收尾 ───────────────────────────────────────────────────────────────
rmSync(root, { recursive: true, force: true });
rmSync(replayRoot, { recursive: true, force: true });

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项未通过`}`);
process.exit(failed === 0 ? 0 : 1);
