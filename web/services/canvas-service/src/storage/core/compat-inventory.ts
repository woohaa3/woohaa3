/**
 * C01–C03 只读兼容盘点（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，任务 6.1）。
 *
 * **纯函数、只读**：只解释已存在的规范聚合与历史条目，绝不写入、迁移或改写。
 * 覆盖 C01 旧尺寸、C02 镜头 aspect、C03 filmSetContent 版本/items，输出非法/冲突/未覆盖项，
 * 供 dry-run 报告与严格化决策使用。
 *
 * 注意（inventory C 组）：无法区分「旧默认」与「人工 resize」时必须报告为未覆盖，
 * 不能凭高度阈值静默覆盖。
 */
import type { ServerCanvas } from "@woohaa3/contracts";
import { MODEL_CAMERA_ASPECTS } from "@woohaa3/contracts";

export type CompatCategory = "C01" | "C02" | "C03";

export type CompatFinding = {
  category: CompatCategory;
  /** 稳定位置标识（canvasId/nodeId[/entryId]/field），不含敏感内容。 */
  location: string;
  /** 稳定机器码，便于统计。 */
  code: string;
  /** 是否属于「可确定的旧默认」（可迁移候选）；false 表示无法确认/未覆盖。 */
  confirmedLegacy: boolean;
  detail?: string;
};

export type CompatInventoryReport = {
  findings: CompatFinding[];
  /** 每个类别的计数（含 confirmed/unconfirmed 分解）。 */
  counts: Record<CompatCategory, { total: number; confirmed: number; unconfirmed: number }>;
};

/** C01 片场旧紧凑尺寸（无卡片 196×64）；恰好命中才是确定旧默认。 */
const FILM_SET_LEGACY_COMPACT_WIDTH = 196;
const FILM_SET_LEGACY_COMPACT_HEIGHT = 64;
/** C01 普通内嵌预览模型的旧紧凑高度阈值。 */
const MODEL_PREVIEW_LEGACY_MAX_HEIGHT = 116;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 盘点单个规范聚合的 C01–C03 候选（只读）。 */
export function inventoryCanvas(canvas: ServerCanvas): CompatFinding[] {
  const findings: CompatFinding[] = [];
  for (const node of canvas.document.nodes) {
    const data = (canvas.nodeData?.[node.id] ?? {}) as Record<string, unknown>;
    const nodeType = node.type;
    const location = `${canvas.id}/${node.id}`;

    // --- C01 旧尺寸 ---
    if (nodeType === "animation3d") {
      const width = node.width;
      const height = node.height;
      if (width === FILM_SET_LEGACY_COMPACT_WIDTH && height === FILM_SET_LEGACY_COMPACT_HEIGHT) {
        findings.push({
          category: "C01",
          location: `${location}/size`,
          code: "film-set-legacy-compact",
          confirmedLegacy: true,
          detail: "恰好 196×64，确定旧片场紧凑默认"
        });
      } else if (width !== undefined && height !== undefined) {
        // 非默认尺寸：无法区分人工 resize → 未覆盖。
        findings.push({
          category: "C01",
          location: `${location}/size`,
          code: "film-set-non-default-size",
          confirmedLegacy: false,
          detail: `尺寸 ${width}×${height}，无法区分旧默认/人工 resize`
        });
      }
    } else if (
      (nodeType === "model3d" || nodeType === "image" || nodeType === "video") &&
      typeof node.height === "number" &&
      node.height > 0 &&
      node.height <= MODEL_PREVIEW_LEGACY_MAX_HEIGHT &&
      hasModelPreviewData(data)
    ) {
      findings.push({
        category: "C01",
        location: `${location}/size`,
        code: "model-preview-legacy-height",
        confirmedLegacy: false,
        detail: `内嵌预览高度 ${node.height} ≤ ${MODEL_PREVIEW_LEGACY_MAX_HEIGHT}，无法区分旧默认/人工 resize`
      });
    }

    // --- C02 镜头 aspect ---
    if (Array.isArray(data.modelCameras)) {
      data.modelCameras.forEach((camera, index) => {
        if (isRecord(camera) && !hasValidAspect(camera.aspect)) {
          findings.push({
            category: "C02",
            location: `${location}/modelCameras[${index}]`,
            code: "model-camera-missing-aspect",
            confirmedLegacy: true,
            detail: camera.aspect === undefined ? "缺 aspect（旧记录）" : `aspect 非法：${String(camera.aspect)}`
          });
        }
      });
    }
    const initialCamera = data.initialCamera;
    if (isRecord(initialCamera) && !hasValidAspect(initialCamera.aspect)) {
      findings.push({
        category: "C02",
        location: `${location}/initialCamera`,
        code: "initial-camera-missing-aspect",
        confirmedLegacy: true,
        detail: initialCamera.aspect === undefined ? "初始镜头缺 aspect" : `aspect 非法：${String(initialCamera.aspect)}`
      });
    }

    // --- C03 filmSetContent 版本/items ---
    if (Object.prototype.hasOwnProperty.call(data, "filmSetContent")) {
      const filmSet = data.filmSetContent;
      if (isRecord(filmSet)) {
        if (filmSet.schemaVersion === undefined) {
          findings.push({
            category: "C03",
            location: `${location}/filmSetContent`,
            code: "film-set-missing-schema-version",
            confirmedLegacy: true,
            detail: "缺 schemaVersion（按 schema 1 读取，不升级为 2）"
          });
        }
        if (filmSet.items === undefined) {
          findings.push({
            category: "C03",
            location: `${location}/filmSetContent`,
            code: "film-set-missing-items",
            confirmedLegacy: true,
            detail: "缺 items（按空集合读取）"
          });
        }
      } else if (filmSet === null) {
        findings.push({
          category: "C03",
          location: `${location}/filmSetContent`,
          code: "film-set-null",
          confirmedLegacy: true,
          detail: "显式 null（按空集合读取）"
        });
      }
    }
  }
  return findings;
}

/** 盘点一条历史条目 payload 的 C01–C03 候选（只读；不解释历史条目本身）。 */
export function inventoryNodeHistoryPayload(input: {
  canvasId: string;
  nodeId: string;
  entryId: string;
  payload: unknown;
}): CompatFinding[] {
  const findings: CompatFinding[] = [];
  if (!isRecord(input.payload)) return findings;
  const location = `${input.canvasId}/${input.nodeId}/${input.entryId}`;
  const payload = input.payload as Record<string, unknown>;

  if (Array.isArray(payload.modelCameras)) {
    payload.modelCameras.forEach((camera, index) => {
      if (isRecord(camera) && !hasValidAspect(camera.aspect)) {
        findings.push({
          category: "C02",
          location: `${location}/payload.modelCameras[${index}]`,
          code: "history-model-camera-missing-aspect",
          confirmedLegacy: true,
          detail: camera.aspect === undefined ? "历史模型镜头缺 aspect" : `aspect 非法：${String(camera.aspect)}`
        });
      }
    });
  }
  const animation = payload.animation;
  if (isRecord(animation)) {
    const initialCamera = animation.initialCamera;
    if (isRecord(initialCamera) && !hasValidAspect(initialCamera.aspect)) {
      findings.push({
        category: "C02",
        location: `${location}/payload.animation.initialCamera`,
        code: "history-initial-camera-missing-aspect",
        confirmedLegacy: true,
        detail: "历史动画初始镜头缺 aspect"
      });
    }
    if (Object.prototype.hasOwnProperty.call(animation, "filmSetContent")) {
      const filmSet = animation.filmSetContent;
      if (isRecord(filmSet)) {
        if (filmSet.schemaVersion === undefined) {
          findings.push({
            category: "C03",
            location: `${location}/payload.animation.filmSetContent`,
            code: "history-film-set-missing-schema-version",
            confirmedLegacy: true,
            detail: "历史片场缺 schemaVersion（按 schema 1）"
          });
        }
        if (filmSet.items === undefined) {
          findings.push({
            category: "C03",
            location: `${location}/payload.animation.filmSetContent`,
            code: "history-film-set-missing-items",
            confirmedLegacy: true,
            detail: "历史片场缺 items（按空集合）"
          });
        }
      }
    }
  }
  return findings;
}

/** 汇总 findings 为报告。 */
export function summarizeCompatInventory(findings: readonly CompatFinding[]): CompatInventoryReport {
  const counts: CompatInventoryReport["counts"] = {
    C01: { total: 0, confirmed: 0, unconfirmed: 0 },
    C02: { total: 0, confirmed: 0, unconfirmed: 0 },
    C03: { total: 0, confirmed: 0, unconfirmed: 0 }
  };
  for (const finding of findings) {
    const bucket = counts[finding.category];
    bucket.total += 1;
    if (finding.confirmedLegacy) bucket.confirmed += 1;
    else bucket.unconfirmed += 1;
  }
  return { findings: [...findings], counts };
}

function hasModelPreviewData(data: Record<string, unknown>): boolean {
  return data.modelScript !== undefined || data.model !== undefined || data.modelCameras !== undefined;
}

function hasValidAspect(aspect: unknown): boolean {
  return typeof aspect === "string" && (MODEL_CAMERA_ASPECTS as readonly string[]).includes(aspect);
}
