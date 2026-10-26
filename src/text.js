/**
 * 把 pet_say 的脚本文本变成"该念出来的话"。
 *
 * 桌宠脚本里可以夹带表情/动作标记（见桌宠的 pet_say 说明）：
 *   【开心, 跳】  先做这些动作，然后换一个新气泡继续说
 *   <眨眼>        打字打到这里时做，不换气泡
 * 气泡里显示的是剥掉标记之后的话，所以念的时候也要剥掉，否则会把"开心""眨眼"念出来。
 *
 * 注意：真正显示的文字其实不一定来自这里——扩展优先读事件库里的 beats[].text，
 * 那是桌宠自己剥好标记、逐段排队显示的文字（见 events.js）。本模块是兜底路径
 * （事件库读不到时改用 toolcalls.jsonl 的 args.script），也在自检里当解析器用。
 */

/** 【…】与 <…>：动作标记。[^】]* / [^<>]* 不跨标记，<> 允许一层嵌套。 */
const MARK = /\u3010[^\u3011]*\u3011|<[^<>]*(?:<[^<>]*>[^<>]*)*>/g;

/** 标记两侧都是词字符时才补一个空格，否则直接删掉。 */
const isWord = (ch) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/**
 * 剥掉标记。返回空串表示这段没有可念的话
 * （例如整段只有 【开心】 这样的纯动作）。
 */
export function cleanScript(text) {
  if (typeof text !== 'string') return '';
  const stripped = text.replace(MARK, (match, offset, whole) => {
    const before = whole[offset - 1];
    const after = whole[offset + match.length];
    return isWord(before) && isWord(after) ? ' ' : '';
  });
  // 换行与连续空白折成单个空格，句首句尾去掉
  return stripped.replace(/\s+/g, ' ').trim();
}

/** 记一笔被剥掉的标记，供自检与排错看。 */
export function stripReport(text) {
  const marks = typeof text === 'string' ? (text.match(MARK) ?? []) : [];
  return { text: cleanScript(text), marks };
}

/** 单句截断：太长的话念起来没完，也不适合当命令行参数。 */
export function truncate(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}\u2026`;
}
