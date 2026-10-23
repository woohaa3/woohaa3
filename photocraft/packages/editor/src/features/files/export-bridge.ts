/**
 * 导出预设消费端口（U04 与栅格交换域的接缝）
 * （change: 2026-10-22-add-photocraft-file-workflows，U04 / design「与栅格交付的单一归属」）。
 *
 * 归属：**导出参数预设的实现、校验与存储由 `features/io/` 唯一持有**
 * （change: 2026-10-22-add-photocraft-raster-interchange 的 `export-presets.ts`）。本域不复制
 * 导出设置、不自己的规则校验 `quality`/`format`/`compression`，只做两件事：
 *
 * 1. 把「导出预设入口」以端口形式暴露给本域面板（文件信息损失预览、导出前提示）；
 * 2. 提供方缺失时**如实说不可用**，而不是自己造一套预设冒充集成。
 *
 * 为什么是鸭子类型而不是直接 import：两个域由不同 change 交付，本域不能在对方落地前把它的
 * 实现打进产物（会形成第二份导出规则）。共享层没有参数通道，`controller.features.io` 是既有的
 * 装配点；提供方一旦在 io 会话上出现 `exportPresets()`，本域无需改动即可消费。
 *
 * 数据形状：`settings` 保持**不透明**（`unknown`）。本域只读取 `format` 用于「按格式报告元数据
 * 损失」，其余字段原样交给提供方回灌，避免在这里长出第二套导出设置类型。
 */

/** 一个导出预设：名称 + 不透明的设置对象（语义由提供方定义）。 */
export type ExportPresetEntry = { name: string; settings: unknown };

/** 提供方返回的原始快照（不可信 JSON）：只接受数组。 */
export type ExportPresetSnapshot = {
  ok: true;
  presets: readonly ExportPresetEntry[];
} | { ok: false; reason: string };

/**
 * 渲染侧上限：只用于拒绝病态输入（避免把十万条预设塞进下拉框）。
 *
 * **不是**导出预设的数量预算——数量上限的唯一真源在协议域
 * `packages/protocol/src/features/io/interchange-budgets.json`（`maxExportPresets`）。
 */
const RENDER_LIMIT = 512;
/** 预设名的显示上限：只影响渲染；名称是否合法仍由提供方判定。 */
const RENDER_NAME_CHARS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 规范化提供方返回的预设列表。
 *
 * 只做**渲染安全**的收窄：非数组/条目不是对象/名字为空或超长 → 丢弃该条；同名只保留第一条。
 * 设置的合法性一概不看——那是提供方的责任，本域若在这里判一遍就成了第二份规则。
 */
export function normalizeExportPresetSnapshot(raw: unknown): ExportPresetSnapshot {
  if (!Array.isArray(raw)) return { ok: false, reason: "导出预设提供方返回的不是列表" };
  const presets: ExportPresetEntry[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (presets.length >= RENDER_LIMIT) break;
    if (!isRecord(entry)) continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name || name.length > RENDER_NAME_CHARS) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    presets.push({ name, settings: entry.settings });
  }
  return { ok: true, presets };
}

/** 从预设设置里读导出格式（只读一个字段，用于元数据损失矩阵）。 */
export function exportPresetFormat(settings: unknown): string | null {
  if (!isRecord(settings)) return null;
  const format = settings.format;
  return typeof format === "string" && format.trim().length > 0 ? format.trim().toLowerCase() : null;
}

/**
 * 导出预设端口。
 *
 * `available: false` 表示当前装配**没有**导出预设提供方（io 域未安装或版本过旧），
 * 调用方必须显示原因并禁用入口，不能退回本域自造的预设列表。
 */
export type ExportPresetPort =
  | {
      available: true;
      list(): ExportPresetSnapshot;
      /** 保存一条预设（提供方支持时才有；本域不落盘、不校验）。 */
      save?: (name: string, settings: unknown) => { ok: true } | { ok: false; reason: string };
      remove?: (name: string) => { ok: true } | { ok: false; reason: string };
    }
  | { available: false; reason: string };

/** 未安装提供方时的统一原因（测试与界面共用一句，避免两处漂移）。 */
export const EXPORT_PRESET_UNAVAILABLE =
  "导出参数预设由栅格格式与导出域提供；当前装配未提供该端口，无法读取或应用导出预设";

type ExportPresetProviderSession = {
  exportPresets?: () => unknown;
  saveExportPreset?: (name: string, settings: unknown) => unknown;
  removeExportPreset?: (name: string) => unknown;
};

function resultOf(raw: unknown, fallback: string): { ok: true } | { ok: false; reason: string } {
  if (isRecord(raw) && raw.ok === true) return { ok: true };
  const reason = isRecord(raw) && typeof raw.reason === "string" && raw.reason.trim() ? raw.reason : fallback;
  return { ok: false, reason };
}

/**
 * 从控制器特性表解析导出预设端口。
 *
 * 只认 `features.io.exportPresets()` 这一个既有装配点；缺失时返回 `available: false`，
 * 不做「先试试别的方法名」的猜测（猜测会让缺失表现为难以诊断的运行时错误）。
 */
export function resolveExportPresetPort(features: unknown): ExportPresetPort {
  const io = isRecord(features) ? features.io : undefined;
  if (!isRecord(io) || typeof io.exportPresets !== "function") {
    return { available: false, reason: EXPORT_PRESET_UNAVAILABLE };
  }
  const session = io as ExportPresetProviderSession;
  return {
    available: true,
    list: () => {
      try {
        return normalizeExportPresetSnapshot(session.exportPresets!());
      } catch (cause) {
        return { ok: false, reason: `读取导出预设失败：${cause instanceof Error ? cause.message : String(cause)}` };
      }
    },
    ...(typeof session.saveExportPreset === "function"
      ? {
          save: (name: string, settings: unknown) => {
            try {
              return resultOf(session.saveExportPreset!(name, settings), `未能保存导出预设「${name}」`);
            } catch (cause) {
              return { ok: false as const, reason: `保存导出预设失败：${cause instanceof Error ? cause.message : String(cause)}` };
            }
          }
        }
      : {}),
    ...(typeof session.removeExportPreset === "function"
      ? {
          remove: (name: string) => {
            try {
              return resultOf(session.removeExportPreset!(name), `未能删除导出预设「${name}」`);
            } catch (cause) {
              return { ok: false as const, reason: `删除导出预设失败：${cause instanceof Error ? cause.message : String(cause)}` };
            }
          }
        }
      : {})
  };
}
