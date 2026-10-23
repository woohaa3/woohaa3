/**
 * 智能层可用性投影的解码（`smartLayerStateJson` 的消费侧）。
 *
 * 内核是可用性与拒绝原因的**唯一来源**；这里只做结构校验，让面板永远拿到
 * 「能不能做 + 为什么不能」这两件事，而不是自己从图层类型推断。
 *
 * 为什么放在本域而不是 `@woohaa3/photocraft-protocol`：把投影类型发布到协议公共入口
 * 需要改 `packages/protocol/src/image-project-content.ts` 与 `src/index.ts` 两个共享门面，
 * 由集成负责人统一提交；在门面同步前，本域自己持有消费侧解码，避免复制第二份内容契约。
 */
export type SmartSourceKind = "embedded" | "linked";

export type SmartLayerState = {
  layer: number;
  smart: boolean;
  contentsId?: number;
  source?: { kind: SmartSourceKind; fileName: string; bytes?: number };
  /** 该层是否正有子文档在编辑。只描述会话，不控制父层替换/导出。 */
  childOpen: boolean;
  canExport: boolean;
  canReplace: boolean;
  canEditContents: boolean;
  canConvertToLayers: boolean;
  /** 各入口不可用的原因；可用时为空串。 */
  exportReason: string;
  replaceReason: string;
  convertReason: string;
  editReason: string;
  /** 当前最主要的不可用原因；可用时为空串。 */
  reason: string;
};

/**
 * 校验内核返回的智能层状态：越界、类型错误或「不可用却不给原因」一律拒绝。
 *
 * 纯函数，不接触 DOM 或 wasm。
 */
export function decodeSmartLayerState(input: unknown): SmartLayerState | null {
  if (!isRecord(input)) return null;
  const layer = input.layer;
  if (!isCount(layer)) return null;
  const reason = text(input.reason);
  if (input.smart !== true) {
    return reason && reason.trim()
      ? {
          layer,
          smart: false,
          childOpen: false,
          canExport: false,
          canReplace: false,
          canEditContents: false,
          canConvertToLayers: false,
          exportReason: reason,
          replaceReason: reason,
          convertReason: reason,
          editReason: reason,
          reason
        }
      : null;
  }
  const contentsId = input.contentsId;
  if (!isCount(contentsId)) return null;
  const source = input.source;
  if (!isRecord(source) || (source.kind !== "embedded" && source.kind !== "linked")) return null;
  const fileName = source.fileName;
  if (typeof fileName !== "string" || !isPlainFileName(fileName)) return null;
  const bytes = source.bytes;
  if (source.kind === "embedded" && (!isCount(bytes) || bytes < 1)) return null;
  const childOpen = input.childOpen;
  const canExport = input.canExport;
  const canReplace = input.canReplace;
  const canEditContents = input.canEditContents;
  const canConvertToLayers = input.canConvertToLayers;
  for (const flag of [childOpen, canExport, canReplace, canEditContents, canConvertToLayers]) {
    if (typeof flag !== "boolean") return null;
  }
  const exportReason = text(input.exportReason);
  const replaceReason = text(input.replaceReason);
  const convertReason = text(input.convertReason);
  const editReason = text(input.editReason);
  if ([exportReason, replaceReason, convertReason, editReason, reason].some(value => value === null)) return null;
  // 不可用的入口必须给出原因：不允许「静默禁用」。
  if (!canExport && !exportReason) return null;
  if (!canReplace && !replaceReason) return null;
  if (!canConvertToLayers && !convertReason) return null;
  if (!canEditContents && !editReason) return null;
  return {
    layer,
    smart: true,
    contentsId,
    source:
      source.kind === "embedded"
        ? { kind: "embedded", fileName, bytes: bytes as number }
        : { kind: "linked", fileName },
    childOpen: childOpen as boolean,
    canExport: canExport as boolean,
    canReplace: canReplace as boolean,
    canEditContents: canEditContents as boolean,
    canConvertToLayers: canConvertToLayers as boolean,
    exportReason: exportReason!,
    replaceReason: replaceReason!,
    convertReason: convertReason!,
    editReason: editReason!,
    reason: reason ?? ""
  };
}

/** 导出源的文件名必须是无路径语义的普通文件名（不含目录分隔与控制字符）。 */
export function isDeliverableSourceName(name: unknown): name is string {
  return typeof name === "string" && isPlainFileName(name) && /\.[a-z0-9]{2,8}$/i.test(name);
}

/** 导出下载名的兜底：内核名字不可交付时也不写出路径。 */
export const FALLBACK_SOURCE_NAME = "smart-object.pcraft";

function isPlainFileName(name: string): boolean {
  return (
    !!name.trim() &&
    name.length <= 200 &&
    !/[\\/:\u0000-\u001f\u007f-\u009f]/.test(name)
  );
}

/** 可选原因字段：缺省视为空串，超长或非字符串视为无效。 */
function text(value: unknown): string | null {
  if (value === undefined) return "";
  return typeof value === "string" && value.length <= 200 ? value : null;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
