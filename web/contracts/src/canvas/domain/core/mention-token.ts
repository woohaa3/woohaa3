/**
 * 参考输入 mention token codec
 * （change: add-reference-inputs-and-mentions，任务 1.1 / design D3）。
 *
 * 规范 token 形如 `{{input_image:slot-opaque-id:图片 1}}`：
 * `type + slotId` 是身份，`label` 只用于可读恢复。
 *
 * 本模块是**无副作用纯函数**：不依赖 React / DOM / Bevy，Frontend 编辑器与 Canvas
 * Service 权威解析共用同一 parser。它只负责语法与文本往返；是否“有权引用某 slot”由
 * 各自的候选/校验逻辑决定（Frontend 按直接 mapping，Canvas Service 按 published Y.Doc）。
 */

/** 首版支持的 mention 类型。 */
export type Woohaa3CanvasMentionType = "input_image" | "input_video" | "input_audio" | "input_text";

export const WOOHAA3_CANVAS_MENTION_TYPES: readonly Woohaa3CanvasMentionType[] = [
  "input_image",
  "input_video",
  "input_audio",
  "input_text"
] as const;

/** 解析出的规范 mention。 */
export type Woohaa3CanvasMention = {
  type: Woohaa3CanvasMentionType;
  slotId: string;
  label: string;
};

/** 文本片段：普通文本或 mention。 */
export type Woohaa3CanvasMentionSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; mention: Woohaa3CanvasMention };

const TOKEN_PREFIX = "{{";
const TOKEN_SUFFIX = "}}";
const TYPE_SET = new Set<string>(WOOHAA3_CANVAS_MENTION_TYPES);
/** 类型 / slotId / label 内都不允许出现这些字符（避免歧义与嵌套）。 */
const FORBIDDEN_IN_FIELD = /[{}:]/;
/** 宽松匹配：`{{type:slotId:label}}`，label 可含空格但不含花括号/冒号。 */
const TOKEN_PATTERN_SOURCE = "\\{\\{(input_(?:image|video|audio|text)):([^{}:]+):([^{}]*)\\}\\}";

/** 是否为受支持的首版 mention 类型。 */
export function isWoohaa3CanvasMentionType(value: unknown): value is Woohaa3CanvasMentionType {
  return typeof value === "string" && TYPE_SET.has(value);
}

/** 单个字段是否合法（非空且不含保留分隔符）。 */
export function isWoohaa3CanvasMentionFieldValid(value: string): boolean {
  return value !== "" && !FORBIDDEN_IN_FIELD.test(value);
}

/**
 * 序列化一个 mention 为规范 token。
 * 字段非法（空 / 含 `{}` / `:`）或类型未知时返回 `null`（绝不产出畸形 token）。
 */
export function serializeWoohaa3CanvasMention(mention: Woohaa3CanvasMention): string | null {
  if (!isWoohaa3CanvasMentionType(mention.type)) return null;
  if (!isWoohaa3CanvasMentionFieldValid(mention.slotId)) return null;
  // label 允许为空（身份不依赖 label），但仍禁止保留字符。
  if (typeof mention.label !== "string" || FORBIDDEN_IN_FIELD.test(mention.label)) return null;
  return `${TOKEN_PREFIX}${mention.type}:${mention.slotId}:${mention.label}${TOKEN_SUFFIX}`;
}

/** 解析单个规范 token；非规范（普通文本 / 畸形）返回 `null`。 */
export function parseWoohaa3CanvasMention(token: string): Woohaa3CanvasMention | null {
  if (typeof token !== "string") return null;
  if (!token.startsWith(TOKEN_PREFIX) || !token.endsWith(TOKEN_SUFFIX)) return null;
  const inner = token.slice(TOKEN_PREFIX.length, token.length - TOKEN_SUFFIX.length);
  const firstColon = inner.indexOf(":");
  const lastColon = inner.lastIndexOf(":");
  if (firstColon <= 0 || lastColon <= firstColon) return null;
  const type = inner.slice(0, firstColon);
  const slotId = inner.slice(firstColon + 1, lastColon);
  const label = inner.slice(lastColon + 1);
  if (!isWoohaa3CanvasMentionType(type)) return null;
  if (!isWoohaa3CanvasMentionFieldValid(slotId)) return null;
  if (FORBIDDEN_IN_FIELD.test(label)) return null;
  return { type, slotId, label };
}

/**
 * 把规范 token 化文本切分为 `text` / `mention` 片段。
 * 无法解析的 `{{...}}` 视作普通文本，保证对任意文本无损。
 */
export function extractWoohaa3CanvasMentions(text: string): Woohaa3CanvasMentionSegment[] {
  if (typeof text !== "string" || text === "") return [];
  const segments: Woohaa3CanvasMentionSegment[] = [];
  const pattern = new RegExp(TOKEN_PATTERN_SOURCE, "g");
  let cursor = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const [raw] = match;
    const parsed = parseWoohaa3CanvasMention(raw);
    // 只有完整合法的 token 才成为 mention；否则并入普通文本。
    if (!parsed) continue;
    if (match.index > cursor) segments.push({ kind: "text", text: text.slice(cursor, match.index) });
    segments.push({ kind: "mention", mention: parsed });
    cursor = match.index + raw.length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

/** 收集文本中所有合法 mention（按出现顺序）。 */
export function collectWoohaa3CanvasMentions(text: string): Woohaa3CanvasMention[] {
  return extractWoohaa3CanvasMentions(text)
    .filter((segment): segment is { kind: "mention"; mention: Woohaa3CanvasMention } => segment.kind === "mention")
    .map((segment) => segment.mention);
}

/** 存储 token → 展示文本：mention 显示为 `@label`，普通文本原样。 */
export function woohaa3CanvasMentionStorageToDisplay(text: string): string {
  return extractWoohaa3CanvasMentions(text)
    .map((segment) => (segment.kind === "text" ? segment.text : `@${segment.mention.label}`))
    .join("");
}

/** 断言文本是否含任意规范 token（供 Task Service 安全防线）。 */
export function containsWoohaa3CanvasMentionToken(text: string): boolean {
  if (typeof text !== "string" || text === "") return false;
  return extractWoohaa3CanvasMentions(text).some((segment) => segment.kind === "mention");
}

/**
 * Provider 文本渲染：文字 token 原位展开为权威文字，媒体 token 渲染为可读文字。
 *
 * - `resolveText(slotId)` 返回该 slot 的权威文字内容，命中时原位替换；
 * - 媒体 token 渲染为 `resolveMediaLabel(mention)`（缺省 `@label`）；
 * - 不递归解释展开文本中的 token（design D4）。
 */
export function renderWoohaa3CanvasMentionProviderText(
  text: string,
  options: {
    resolveText?: (slotId: string) => string | null;
    resolveMediaLabel?: (mention: Woohaa3CanvasMention) => string;
  } = {}
): { text: string; unresolved: Woohaa3CanvasMention[] } {
  const unresolved: Woohaa3CanvasMention[] = [];
  const rendered = extractWoohaa3CanvasMentions(text)
    .map((segment) => {
      if (segment.kind === "text") return segment.text;
      const { mention } = segment;
      if (mention.type === "input_text") {
        const resolved = options.resolveText?.(mention.slotId);
        if (resolved === null || resolved === undefined) {
          unresolved.push(mention);
          return options.resolveMediaLabel?.(mention) ?? `@${mention.label}`;
        }
        return resolved;
      }
      return options.resolveMediaLabel?.(mention) ?? `@${mention.label}`;
    })
    .join("");
  return { text: rendered, unresolved };
}

/**
 * 展示文本 → 存储 token：把 `@label` 恢复为 token。
 *
 * label 可能含空格，无法仅靠正则无歧义解析，因此由调用方给出当前候选列表，
 * 按**最长 label 优先**在 `@` 处匹配（label 仅用于可读恢复，不参与授权）。
 * 普通 `@文字` 不匹配任何候选时原样保留。
 */
export function woohaa3CanvasMentionDisplayToStorage(
  display: string,
  candidates: readonly { label: string; mention: Woohaa3CanvasMention }[]
): string {
  if (typeof display !== "string" || display === "") return display;
  // 长 label 优先，避免「图片 1」被「图片」抢占。
  const ordered = [...candidates].sort((left, right) => right.label.length - left.label.length);
  let out = "";
  let index = 0;
  while (index < display.length) {
    const char = display[index];
    if (char === "@") {
      const rest = display.slice(index + 1);
      const match = ordered.find((candidate) => candidate.label !== "" && rest.startsWith(candidate.label));
      if (match) {
        const token = serializeWoohaa3CanvasMention(match.mention);
        if (token) {
          out += token;
          index += 1 + match.label.length;
          continue;
        }
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * 校验 token 列表是否都能匹配到候选 slot（Frontend 预检用；权威判定在 Canvas Service）。
 * 返回无法匹配的 mention（失效 token）。
 */
export function findUnresolvedWoohaa3CanvasMentions(
  text: string,
  candidates: readonly { slotId: string; type: Woohaa3CanvasMentionType }[]
): Woohaa3CanvasMention[] {
  const bySlot = new Map(candidates.map((candidate) => [candidate.slotId, candidate.type]));
  return collectWoohaa3CanvasMentions(text).filter((mention) => bySlot.get(mention.slotId) !== mention.type);
}
