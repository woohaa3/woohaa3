/**
 * ChatGPT 生成编排：候选解码与归一化
 * （自 `generation.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R09）。
 */
import { canonicalFilmSetFields, FILM_SET_EXTENSION_ID, type FilmSetNodeData, type ModelCameraMutation } from "@woohaa3/contracts";

/** 解析候选 JSON；SDK 结构化输出失败时给出可读原因。 */
export function parseCandidateText(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, message: "推理未返回候选内容。" };
  // 允许模型包裹 ```json 代码块。
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(trimmed);
  const payload = fenced ? fenced[1]! : trimmed;
  try {
    return { ok: true, value: JSON.parse(payload) as unknown };
  } catch {
    return { ok: false, message: "推理返回不是合法 JSON，无法作为候选结果。" };
  }
}

export function normalizeTimeline(input: unknown, fallback: FilmSetNodeData["timeline"]): FilmSetNodeData["timeline"] {
  if (typeof input !== "object" || input === null) return fallback;
  const duration = (input as { duration?: unknown }).duration;
  const loop = (input as { loop?: unknown }).loop;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return fallback;
  return { duration, loop: typeof loop === "boolean" ? loop : fallback.loop };
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

/**
 * 归一结构化输出的镜头变更：把严格 schema 产生的 `null` 可选字段丢弃，仅保留有值字段。
 */
export function normalizeCameraMutations(input: unknown): ModelCameraMutation[] {
  if (!Array.isArray(input)) return [];
  const out: ModelCameraMutation[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const kind = entry.kind;
    const id = typeof entry.id === "string" ? entry.id : undefined;
    const name = typeof entry.name === "string" ? entry.name : undefined;
    const azimuth = typeof entry.azimuth === "number" ? entry.azimuth : undefined;
    const elevation = typeof entry.elevation === "number" ? entry.elevation : undefined;
    const distance = typeof entry.distance === "number" ? entry.distance : undefined;
    const aspect = typeof entry.aspect === "string" ? entry.aspect : undefined;
    const focusOffset =
      entry.focusOffset && typeof entry.focusOffset === "object"
        ? (entry.focusOffset as { x?: unknown; y?: unknown; z?: unknown })
        : null;
    const focus = focusOffset && typeof focusOffset.x === "number" && typeof focusOffset.y === "number" && typeof focusOffset.z === "number"
      ? { x: focusOffset.x, y: focusOffset.y, z: focusOffset.z }
      : undefined;
    switch (kind) {
      case "create":
        if (typeof azimuth !== "number" || typeof distance !== "number") break;
        out.push({ kind: "create", azimuth, distance, ...(name ? { name } : {}), ...(elevation !== undefined ? { elevation } : {}), ...(aspect ? { aspect: aspect as never } : {}), ...(focus ? { focusOffset: focus } : {}) });
        break;
      case "update":
        if (!id) break;
        out.push({ kind: "update", id, ...(azimuth !== undefined ? { azimuth } : {}), ...(elevation !== undefined ? { elevation } : {}), ...(distance !== undefined ? { distance } : {}), ...(aspect ? { aspect: aspect as never } : {}), ...(focus ? { focusOffset: focus } : {}) });
        break;
      case "remove":
        if (id) out.push({ kind: "remove", id });
        break;
      case "rename":
        if (id && name) out.push({ kind: "rename", id, name });
        break;
      case "reset":
        if (!id || typeof azimuth !== "number" || typeof distance !== "number") break;
        out.push({ kind: "reset", id, azimuth, distance, ...(elevation !== undefined ? { elevation } : {}) });
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * 把 items-only 片场定义还原为 canonical flat nodeData 以便复用权威 decoder
 * （change: 2026-10-11-extract-film-set-extension，D7/D8/D10：不再有顶层 authored 模型）。
 */
export function toFlatAnimation(animation: FilmSetNodeData): Record<string, unknown> {
  return { extensionId: FILM_SET_EXTENSION_ID, ...canonicalFilmSetFields(animation) };
}
