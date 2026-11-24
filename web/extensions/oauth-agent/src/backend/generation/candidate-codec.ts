/**
 * ChatGPT 生成编排：候选解码与归一化
 * （自 `generation.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R09）。
 */

/** 解析候选 JSON；SDK 结构化输出失败时给出可读原因。 */
export function parseCandidateText(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, message: "推理未返回候选内容。" };
  // 允许模型包裹 ```json 代码块。
  const payload = unfence(trimmed);
  try {
    return { ok: true, value: JSON.parse(payload) as unknown };
  } catch {
    return { ok: false, message: "推理返回不是合法 JSON，无法作为候选结果。" };
  }
}

/**
 * 去掉 Markdown 代码围栏。
 *
 * 原实现是 `/^```(?:json)?\s*([\s\S]*?)\s*```$/m`：围栏头尾两侧的 `\s*` 与惰性捕获
 * 都能吞空白，未闭合的围栏（模型被截断时常见）会让引擎在两者之间反复退让——实测
 * 4000 个空格要 16.8 s。围栏的语义只是「某一行是围栏头、之后某一行是围栏尾」，按行
 * 扫一遍就够，不需要正则回溯。`m` 标志允许围栏前有别的话术，这里照样保留。
 */
function unfence(text: string): string {
  const lines = text.split("\n");
  for (let start = 0; start < lines.length; start += 1) {
    const line = lines[start]!;
    if (!line.startsWith("```")) continue;
    // 围栏头只接受空标注或 json；其他语言标注不是候选 JSON，原样交给 JSON.parse 报错。
    const header = line.slice(3).trim();
    if (header !== "" && header !== "json") continue;
    for (let end = start + 1; end < lines.length; end += 1) {
      if (lines[end]!.trim() === "```") return lines.slice(start + 1, end).join("\n").trim();
    }
  }
  return text;
}

/**
 * 防破坏护栏：候选模型脚本相对既有脚本大幅缩水时判定为「疑似整体重写」，除非用户明确要求重建。
 */
export function overwriteGuard(userPrompt: string, previousSource: string | undefined, nextSource: string): string | null {
  const prev = typeof previousSource === "string" ? previousSource.trim() : "";
  const next = nextSource.trim();
  if (prev.length < 800) return null;
  if (rebuildRequested(userPrompt)) return null;
  if (next.length >= prev.length * 0.4) return null;
  return `候选模型（${next.length} 字符）远小于现有模型（${prev.length} 字符），疑似整体重写并丢失部件；已拒绝以免破坏现有模型。如确实需要重建，请在提示词里明确说明「重建/重写整个模型」。`;
}

/** 提示词是否明确要求整体重建（中英文关键词）。 */
function rebuildRequested(prompt: string): boolean {
  return /重建|重写|重做|从头|重新做|全部替换|整体替换|replace the (whole|entire)|rebuild|from scratch|rewrite the (whole|entire)/i.test(prompt);
}
