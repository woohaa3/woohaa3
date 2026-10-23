/**
 * 画板与切片导出（U56）。
 *
 * 分成两段，边界清楚：
 * 1. **范围与命名**来自内核 `compositionExportPlanJson(kind)`：切片表由内核解析（含自动切片与
 *    同名去重），画板矩形来自画板属性。界面不自己推算范围，避免与内核不一致。
 * 2. **编码与落盘**：每个产物由内核 `compositionExportPng(rect)` 直接给出 PNG 字节（编码器只在
 *    内核一侧），再经宿主的文件交付端口交出。浏览器没有任意路径写权限，因此导出是「多个文件
 *    依次交付」，而不是写某个目录——这正是 scope 里「原生文件夹输出不接入」与「导出范围/命名
 *    正确」的接缝。
 *
 * 任一产物失败即整体失败并返回具体原因；不静默跳过，否则用户会以为全部导出成功。
 */
import type { EditorFailure, EditorResult } from "../../editor-wasm.js";
import type { EditorFilePort } from "../../ports.js";
/**
 * 导出只需要构图句柄的这两项能力。
 *
 * 用最小结构类型而不是整份域句柄：调用方（控制器）暴露的是裁剪后的子集，按最小需求声明可以
 * 让替身与真实句柄都能满足，也不会因为别的域方法增删而连坐。
 */
export type CompositionExportHost = {
  compositionExportPlan(kind: CompositionExportKind): EditorResult<unknown>;
  compositionExportPng(rect: { x: number; y: number; width: number; height: number }): EditorResult<Uint8Array>;
};

/** 内核给出的单个导出产物。 */
export type CompositionExportEntry = {
  fileName: string;
  name: string;
  rect: [number, number, number, number];
  kind?: string;
  layer?: number;
};

export type CompositionExportKind = "slices" | "artboards";

export type CompositionExportResult = {
  /** 已交付的文件名，顺序与计划一致。 */
  delivered: string[];
  /** 宿主是否确认真正写入磁盘（否则只是发起了下载）。 */
  written: boolean;
};

/** 解析内核计划；结构非法时返回具体原因而不是空数组。 */
export function parseExportPlan(value: unknown): EditorResult<CompositionExportEntry[]> {
  if (!value || typeof value !== "object") return { ok: false, code: "bad-plan", message: "导出计划为空" };
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, code: "bad-plan", message: "导出计划里没有文件" };
  }
  const entries: CompositionExportEntry[] = [];
  for (const [index, raw] of files.entries()) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, code: "bad-plan", message: `第 ${index + 1} 个导出产物结构非法` };
    }
    const file = raw as Record<string, unknown>;
    const { fileName, name, rect } = file;
    if (typeof fileName !== "string" || !fileName) {
      return { ok: false, code: "bad-plan", message: `第 ${index + 1} 个导出产物缺少文件名` };
    }
    if (typeof name !== "string") {
      return { ok: false, code: "bad-plan", message: `${fileName} 缺少名称` };
    }
    if (!Array.isArray(rect) || rect.length !== 4
      || !rect.every((value) => typeof value === "number" && Number.isFinite(value))) {
      return { ok: false, code: "bad-plan", message: `${fileName} 的导出范围非法` };
    }
    const [x, y, width, height] = rect as number[];
    if (width <= 0 || height <= 0) {
      return { ok: false, code: "bad-plan", message: `${fileName} 的导出范围为空` };
    }
    entries.push({
      fileName,
      name,
      rect: [x, y, width, height],
      ...(typeof file.kind === "string" ? { kind: file.kind } : {}),
      ...(typeof file.layer === "number" ? { layer: file.layer } : {})
    });
  }
  return { ok: true, value: entries };
}

/**
 * 依次导出 `kind` 的全部产物。
 *
 * `deliver` 是宿主的文件交付端口；未提供时明确报「不支持本地文件保存」，而不是假装成功。
 */
export async function exportCompositionArtifacts(
  composition: CompositionExportHost,
  kind: CompositionExportKind,
  deliver: EditorFilePort | undefined
): Promise<EditorResult<CompositionExportResult>> {
  if (!deliver) return { ok: false, code: "no-port", message: "当前宿主不支持本地文件保存" };
  const plan = composition.compositionExportPlan(kind);
  if (!plan.ok) return plan as EditorFailure;
  const parsed = parseExportPlan(plan.value);
  if (!parsed.ok) return parsed;
  const delivered: string[] = [];
  let written = true;
  for (const entry of parsed.value) {
    const [x, y, width, height] = entry.rect;
    const png = composition.compositionExportPng({ x, y, width, height });
    if (!png.ok) return png as EditorFailure;
    const result = await deliver({ fileName: entry.fileName, contentType: "image/png", bytes: png.value });
    if (!result.ok) {
      return { ok: false, code: "delivery-failed", message: result.message ?? `导出 ${entry.fileName} 失败` };
    }
    if (result.status !== "written") written = false;
    delivered.push(entry.fileName);
  }
  return { ok: true, value: { delivered, written } };
}
