/**
 * 在 JSON 文本里**就地**改写 `version` 值，其余字节一律不动。
 *
 * 为什么不用 `JSON.stringify(parsed, null, 2)`：仓库里的 `extension.json` 大量使用紧凑嵌套写法
 * （`"metadata": { "module": "./shared", ... }` 写在一行）。整体重新序列化会把它们全部展开，
 * 一个「新增一个 version 字段」的改动会变成几十行格式噪音，把真正的语义变更淹没在 diff 里
 * （实施中确实发生过：34 个文件、513 行插入，其中约 400 行是缩进变化）。
 *
 * 做法：先用 JSON.parse 确认结构，再按「键名 + 值的原始切片」逐处替换。
 * 不依赖手写词法分析——`JSON.parse` 已经保证了文本合法，替换只发生在可精确定位的片段上。
 *
 * 支持的更新：
 * - `top`：顶层 `version`；
 * - `site`：`site.version`（仅当 `site` 是对象且已有 `version` 键时改写）；
 * - `insertTop`：顶层**没有** `version` 键时，在根对象末尾插入（用于补齐缺失字段）。
 *
 * 返回值 `{ text, changed }`。定位失败时抛错——宁可失败，也不要静默写出一个语义错误的文件。
 */

/** 在文本里找到「最后一个 key 出现位置」的值区间。`occurrence` 0 表示第一次。 */
function valueSpan(text, key, occurrence = 0) {
  const pattern = new RegExp(`"${key}"\\s*:\\s*`, "g");
  let match;
  let seen = 0;
  let last = null;
  while ((match = pattern.exec(text)) !== null) {
    if (seen === occurrence) last = match;
    seen += 1;
  }
  // 没有第 occurrence 次出现时，用最后一次（调用方通常只想改唯一那一处）。
  const target = last ?? null;
  if (!target) return null;
  const start = target.index + target[0].length;
  if (text[start] !== '"') return null;
  let end = start + 1;
  while (end < text.length) {
    if (text[end] === "\\") {
      end += 2;
      continue;
    }
    if (text[end] === '"') break;
    end += 1;
  }
  return { start, end: end + 1 }; // [start, end) 含两侧引号
}

/** 把 `site` 对象内部的 `version` 值区间定位出来（只在 site 的 `{...}` 范围内找）。 */
function siteVersionSpan(text) {
  const siteKey = /"site"\s*:\s*\{/.exec(text);
  if (!siteKey) return null;
  const openBrace = siteKey.index + siteKey[0].length - 1;
  // 从 `{` 起配对，跳过字符串。
  let depth = 0;
  let quote = false;
  let closeBrace = -1;
  for (let index = openBrace; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') {
      quote = true;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        closeBrace = index;
        break;
      }
    }
  }
  if (closeBrace < 0) return null;
  const body = text.slice(openBrace, closeBrace + 1);
  const span = valueSpan(body, "version");
  if (!span) return null;
  return { start: openBrace + span.start, end: openBrace + span.end };
}

export function rewriteJsonVersionLiterals(text, { top, site, insertTop } = {}) {
  // 先确认文本合法，非法时让调用方拿到明确错误而不是写出半成品。
  const parsed = JSON.parse(text);
  const replacements = [];

  const hasTopVersion = typeof parsed?.version === "string";
  if (hasTopVersion && typeof top === "string") {
    const span = valueSpan(text, "version");
    if (!span) throw new Error("无法在 extension.json 中定位顶层 version 的值");
    // 值已经相同就不动，保证 `changed` 如实反映「有没有产生 diff」。
    if (text.slice(span.start, span.end) !== `"${top}"`) {
      replacements.push({ ...span, value: `"${top}"` });
    }
  }
  if (typeof site === "string" && parsed?.site && typeof parsed.site === "object") {
    const span = siteVersionSpan(text);
    if (span && text.slice(span.start, span.end) !== `"${site}"`) {
      replacements.push({ ...span, value: `"${site}"` });
    }
  }

  // 顶层没有 version：在最后一个 `}` 之前插入，保留原有的尾随换行与缩进风格。
  let insertion = null;
  if (!hasTopVersion && typeof insertTop === "string") {
    const closeIndex = text.lastIndexOf("}");
    if (closeIndex < 0) throw new Error("无法在 extension.json 中定位根对象结尾");
    const before = text.slice(0, closeIndex).trimEnd();
    const needsComma = !before.endsWith("{") && !before.endsWith(",");
    // 沿用文件里已有的两空格缩进。
    insertion = { at: closeIndex, text: `${needsComma ? "," : ""}\n  "version": "${insertTop}"\n` };
  }

  if (replacements.length === 0 && !insertion) return { text, changed: false };

  // 从后往前替换，避免前面的偏移影响后面的位置。
  let next = text;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, replacement.start) + replacement.value + next.slice(replacement.end);
  }
  if (insertion) {
    // 插入点在最后，前面的替换不会移动它（都在它之前，但长度变化会移动位置）——用新文本重算。
    const closeIndex = next.lastIndexOf("}");
    const before = next.slice(0, closeIndex).trimEnd();
    const needsComma = !before.endsWith("{") && !before.endsWith(",");
    next = `${before}${needsComma ? "," : ""}\n  "version": "${insertTop}"\n${next.slice(closeIndex)}`;
  }

  // 自校验：改完必须仍是合法 JSON，且版本确实生效。
  const after = JSON.parse(next);
  if (typeof top === "string" && after.version !== top) throw new Error("顶层 version 改写后校验失败");
  if (typeof insertTop === "string" && after.version !== insertTop) throw new Error("顶层 version 插入后校验失败");
  if (typeof site === "string" && after.site && after.site.version !== site) throw new Error("site.version 改写后校验失败");

  return { text: next, changed: true };
}
