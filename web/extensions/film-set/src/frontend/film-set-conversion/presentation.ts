import { readFilmSetConversionNodeStatus, type ServerCanvas } from "@woohaa3/contracts";
/**
 * 「转为片场」动作的就近状态映射（纯函数）
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.6/3.8 / design D4/D7）。
 *
 * 与 React/DOM 解耦，供组件与非渲染回归共用：把**权威**步骤/状态映射为阶段文案、失败原因与
 * 恢复动作，并按真实比例可用性决定是否显示百分比（本 change 后端不提供比例，因此只显示阶段）。
 * 不缓存任务状态、不制造第二份事实来源。
 */
import type {
  FilmSetConversionErrorCode,
  FilmSetConversionModelCandidate,
  FilmSetConversionSourceKind,
  FilmSetConversionStatus
} from "@woohaa3/contracts";

/** 真实执行阶段的中文文案（来自后端 `FilmSetConversionStep`）。 */
export const FILM_SET_CONVERSION_STEP_LABELS = {
  "prepare-source": "准备素材",
  "analyze-content": "分析内容",
  "generate-film-set": "生成片场",
  "validate-and-save": "校验并保存"
} as const;

/** 失败描述：按错误类别区分的**标题**、该类别的回退原因，以及就近恢复动作。 */
export type FilmSetConversionFailureDescription = {
  /** 失败标题（按错误类别区分，例如「片场候选未通过校验」），不再一律显示「转换失败」。 */
  title: string;
  /** 该类别的可读原因（没有具体 message 时的回退文案）。 */
  reason: string;
  /** 就近恢复动作。 */
  recovery: string;
};

/** 稳定错误码 → 按类别区分的标题 + 可读原因 + 就近恢复动作。 */
export function describeFilmSetConversionFailure(code: FilmSetConversionErrorCode): FilmSetConversionFailureDescription {
  switch (code) {
    case "model-required":
    case "model-not-configured":
      return { title: "未选择转换模型", reason: "尚未选择可用的转换模型", recovery: "打开设置选择模型" };
    case "model-not-vision-capable":
      return { title: "模型不支持视觉输入", reason: "所选模型不支持读取图片或视频内容", recovery: "重新选择支持视觉的模型" };
    case "model-no-structured-output":
      return { title: "模型不支持结构化输出", reason: "所选模型不支持结构化片场候选输出", recovery: "重新选择模型" };
    case "source-not-found":
      return { title: "来源已删除", reason: "来源节点已删除", recovery: "重新选择来源节点" };
    case "source-not-ready":
      return { title: "素材未就绪", reason: "来源素材尚未就绪", recovery: "等待导入完成或重试读取" };
    case "unsupported-source":
      return { title: "来源类型不支持", reason: "该来源类型暂不支持转换", recovery: "改选图片、视频或 3D 模型" };
    case "range-required":
    case "budget-exceeded":
      return { title: "超出模型预算", reason: "所选视频范围超出模型预算", recovery: "调整视频范围或更换模型" };
    case "candidate-invalid":
      return { title: "片场候选未通过校验", reason: "模型返回的片场候选未通过校验", recovery: "重试或调整设置" };
    case "stale-source":
      return { title: "来源已变化", reason: "来源内容在提交前发生变化", recovery: "重新发起转换" };
    case "unauthorized":
      return { title: "无法继续创建片场", reason: "没有执行权限", recovery: "检查画布权限或助手连接" };
    case "commit-failed":
      return { title: "片场保存失败", reason: "片场创建提交失败", recovery: "重试保存" };
    case "request-id-reused":
      return { title: "请求冲突", reason: "同一请求被用于不同输入", recovery: "重新发起转换" };
    case "unknown-result":
      return { title: "结果未知", reason: "无法确认转换结果", recovery: "查询结果" };
    case "canvas-not-found":
    case "canvas-unavailable":
      return { title: "画布不可用", reason: "当前画布不可用", recovery: "刷新画布后重试" };
    case "generation-failed":
      return { title: "上游生成失败", reason: "上游推理失败", recovery: "重试" };
    case "cancelled":
      return { title: "转换已取消", reason: "转换已取消", recovery: "重新转换" };
    case "malformed-request":
      return { title: "请求非法", reason: "请求格式非法", recovery: "重新发起转换" };
    default:
      return { title: "转换失败", reason: "转换失败", recovery: "重试" };
  }
}

/** 断点展示视图：主按钮旁的就近提示。 */
export type FilmSetConversionPresentation = {
  /** 状态种类（用于样式与行为分支）。 */
  kind: "idle" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  /** 主要文案（就绪时为空串）。 */
  label: string;
  /** 真实阶段文案（`running` 时存在）。 */
  step?: string;
  /** 失败原因（`failed` 时存在）。 */
  reason?: string;
  /** 就近恢复动作文案（失败/取消/未知时存在）。 */
  recovery?: string;
  /** 是否可取消（未提交工作）。 */
  cancellable: boolean;
  /** 是否可重试（显式重新推理）。 */
  retryable: boolean;
  /** 是否提供「打开片场」。 */
  openable: boolean;
  /** 是否应查询核对（unknown，不自动重跑）。 */
  needsQuery: boolean;
  /** 是否以 polite live region 播报（后台完成不抢焦点）。 */
  announce: boolean;
};

/** 按权威状态映射断点视图；`null` 表示尚无请求（就绪）。 */
export function presentFilmSetConversionStatus(status: FilmSetConversionStatus | null): FilmSetConversionPresentation {
  if (!status) {
    return { kind: "idle", label: "", cancellable: false, retryable: false, openable: false, needsQuery: false, announce: false };
  }
  switch (status.status) {
    case "running":
      return {
        kind: "running",
        label: "正在转为片场",
        step: FILM_SET_CONVERSION_STEP_LABELS[status.step],
        cancellable: true,
        retryable: false,
        openable: false,
        needsQuery: false,
        announce: true
      };
    case "completed":
      return { kind: "completed", label: "片场已创建", cancellable: false, retryable: false, openable: true, needsQuery: false, announce: true };
    case "cancelled":
      return { kind: "cancelled", label: "已取消转换", recovery: "重新转换", cancellable: false, retryable: true, openable: false, needsQuery: false, announce: true };
    case "unknown":
      // 结果未知（例如服务重启后本地已无在途任务）仍可取消：取消把未提交工作落为终态，
      // 使占位片场节点脱离「进行中」而可删除（否则会永久卡在无法删除的状态）。
      return { kind: "unknown", label: "正在确认转换结果", recovery: "查询结果", cancellable: true, retryable: false, openable: false, needsQuery: true, announce: true };
    case "failed": {
      const described = describeFilmSetConversionFailure(status.code);
      // 标题按错误类别区分；详情优先显示后端给出的**具体**原因（例如「对象 X 的 capsule 总高度不得小于直径」），
      // 与类别原因重复时不重复展示（避免「候选未通过校验 · 候选未通过校验」）。
      const detail = status.message && status.message.trim() !== "" ? status.message.trim() : described.reason;
      return {
        kind: "failed",
        label: described.title,
        reason: detail !== described.reason ? detail : undefined,
        recovery: described.recovery,
        cancellable: false,
        retryable: status.retryable,
        openable: false,
        needsQuery: false,
        announce: true
      };
    }
  }
}

/**
 * 主按钮默认是否可直接开始（一次点击）：
 *
 * 有显式模型且该模型**声明支持该来源**时直接提交；无显式选择但有唯一「默认且支持」的候选时
 * 也直接采用。多个候选且无明确默认、或已选模型不能承担该来源时，打开就近设置（不猜测、不静默
 * 换 Provider）。
 */
export function resolveFilmSetConversionDirectStart(input: {
  models: readonly FilmSetConversionModelCandidate[];
  modelKey?: string;
  sourceKind: FilmSetConversionSourceKind;
}): { start: true; modelKey: string | undefined } | { start: false; reason: string } {
  const { models, modelKey, sourceKind } = input;
  if (modelKey) {
    const selected = models.find((model) => model.modelKey === modelKey);
    if (selected && selected.supports.includes(sourceKind)) return { start: true, modelKey: selected.modelKey };
    return { start: false, reason: selected ? "所选模型不支持该来源，请重新选择" : "已保存的模型当前不可用，请重新选择" };
  }
  const supporting = models.filter((model) => model.supports.includes(sourceKind));
  if (supporting.length === 0) return { start: false, reason: "尚未配置支持该来源的转换模型" };
  const declaredDefault = supporting.filter((model) => model.isDefault);
  if (declaredDefault.length === 1) return { start: true, modelKey: declaredDefault[0]!.modelKey };
  if (supporting.length === 1) return { start: true, modelKey: supporting[0]!.modelKey };
  return { start: false, reason: "存在多个候选模型，请选择要使用的模型" };
}

/**
 * 设置弹窗的**推荐默认模型**（design D6/D7）。
 *
 * 多个候选且无明确默认时主按钮会打开就近设置；弹窗据此把选择预置到「默认且支持该来源 →
 * 支持该来源的第一个」候选，使用户直接点「开始转换」就有一个可用的模型，而不是以空选择提交后
 * 被拒绝。只做**可见**预选（Listbox 会显示），不静默换 Provider。无支持候选返回 `undefined`
 * （由配置入口/显式选择接管，不预置必然失败的模型）。
 */
export function resolveFilmSetConversionPreferredModelKey(input: {
  models: readonly FilmSetConversionModelCandidate[];
  sourceKind: FilmSetConversionSourceKind;
}): string | undefined {
  const { models, sourceKind } = input;
  const candidate = models.find((model) => model.isDefault && model.supports.includes(sourceKind))
    ?? models.find((model) => model.supports.includes(sourceKind));
  return candidate?.modelKey;
}

/**
 * 主按钮旁的模型名摘要：有显式选择时用其展示名（缺失回退 modelKey），否则用将采用的默认候选。
 * 无候选时返回 null（前端据此显示配置入口而非随机候选）。
 */
export function summarizeFilmSetConversionModel(input: {
  models: readonly FilmSetConversionModelCandidate[];
  modelKey?: string;
  sourceKind: FilmSetConversionSourceKind;
}): { label: string; modelKey: string; available: boolean } | null {
  const { models, modelKey, sourceKind } = input;
  if (models.length === 0) return null;
  const selected = modelKey ? models.find((model) => model.modelKey === modelKey) : undefined;
  if (selected) return { label: selected.label || selected.modelKey, modelKey: selected.modelKey, available: selected.supports.includes(sourceKind) };
  const candidate = models.find((model) => model.isDefault && model.supports.includes(sourceKind))
    ?? models.find((model) => model.supports.includes(sourceKind))
    ?? models[0]!;
  return { label: candidate.label || candidate.modelKey, modelKey: candidate.modelKey, available: candidate.supports.includes(sourceKind) };
}

export function resolveConversionNodeStatuses(canvas: ServerCanvas | null): { nodeId: string; status: FilmSetConversionStatus }[] {
  if (!canvas) return [];
  return canvas.document.nodes.flatMap(node => {
    if (node.type !== "composite-asset") return [];
    const status = readFilmSetConversionNodeStatus(canvas.nodeData[node.id]);
    return status ? [{ nodeId: node.id, status }] : [];
  });
}
