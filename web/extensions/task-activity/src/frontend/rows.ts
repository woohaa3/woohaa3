/**
 * 统一活动记录模型（change: 2026-10-22-unify-task-activity-rows，任务 1.1 / design D1 / D3）。
 *
 * 面板只消费 `ActivityRow`：`kind` 只决定**数据来源**与可用动作，不决定寿命、排序、关闭方式
 * 或清理规则。三个接入适配器（`adapt-task-row` / `adapt-job-row` / `adapt-group-row`）把各自
 * 来源的载荷转成这一种记录，「是否进行中」的判定留在适配器里，因为那是来源语义而不是面板语义。
 *
 * 移除后的「不复活」同样按来源分工（design D2）：
 *
 * - 任务 / 后台活动：store 写 `expired` 键集合，事件或轮询重放时丢弃；
 * - 组创作：来源是宿主的整表轮询，没有增量事件可丢；移除写 `dismissedGroups`，由
 *   `replaceGroupRuns` 在记录重新 active 时清除，并由组节点入口显式重开。
 *
 * 面板自身只认 `active` 与 `key`：`key` 是稳定身份（`task:<runId>` / `job:<id>` /
 * `group:<requestId>`），`exitingKeys` 也以它为键（design D3）。
 */
import type { BackgroundActivityJob, CanvasTaskActivity, SkillMediaStepView } from "@woohaa3/contracts";
import { reportedProgressPercent, roundedGenerationPercent } from "@woohaa3/contracts";
import type { CanvasGroupRun } from "@woohaa3/frontend/extension-api";
import type { ActivityFeedItem, BackgroundFeedJob } from "./store.js";

export type ActivityRowKind = "task" | "job" | "group" | "skill";

/** 状态语义色，仅用于行内状态灯与状态文案，不承载来源判别。 */
export type ActivityRowTone = "active" | "success" | "danger" | "muted";

/** 记录携带的来源载荷：只保留该来源详情预览需要的字段。 */
export type ActivityRowSource =
  | { kind: "task"; item: ActivityFeedItem }
  | { kind: "job"; job: BackgroundFeedJob }
  | { kind: "group"; run: CanvasGroupRun }
  | { kind: "skill"; step: SkillMediaStepView };

/**
 * 记录声明的可用动作。字段存在即表示该动作可用，因此 renderer 不需要按来源分支。
 *
 * 组创作额外声明两个交互能力（design D4 的「保留风险」）：点击锁定预览（`pinOnOpen`）与
 * 被组节点选中时自动展开并滚动到可视区（`autoOpenOnSelect`）。
 */
export type ActivityRowActions = {
  /** 终态记录可关闭；进行中记录不可关闭。 */
  close: boolean;
  /** 定位画布节点（任务 / 后台活动）或创作组（组记录）。 */
  locate?: () => void;
  /** 主行标题可打开详情（作品生成历史或确切 Agent 详情）。 */
  openDetail?: () => void;
  /** 组创作的停止 / 重试原请求；只有写权限与来源可用时才存在。 */
  stop?: () => Promise<void>;
  retry?: () => Promise<void>;
  openConversation?: () => Promise<void>;
  /** 组记录详情中的写操作需要画布可写。 */
  writable?: boolean;
  /** 点击主行锁定详情（组记录）；缺省时悬停即预览。 */
  pinOnOpen?: boolean;
  /** 被组节点选中时自动展开详情并滚动到可视区。 */
  autoOpenOnSelect?: boolean;
};

export type ActivityRow = {
  /** 稳定身份：`task:<runId>` | `job:<id>` | `group:<requestId>`。 */
  key: string;
  kind: ActivityRowKind;
  /** 主行文案（已解析）。 */
  title: string;
  /** 次行：模型可读名或来源细节。 */
  secondary?: string;
  /** 详情补充说明（失败原因、组错误）；缺省时不渲染该段。 */
  detail?: string;
  /** 状态文案（不含进度百分比，进度由面板按 `progress` 追加）。 */
  status: string;
  /** 来源原始状态码，只用于 `data-state` 诊断与既有样式钩子。 */
  state: string;
  tone: ActivityRowTone;
  /** 0..1，仅进行中有意义。 */
  progress?: number;
  nodeId?: string;
  createdAt: string;
  updatedAt: string;
  /** 是否进行中：面板唯一的寿命判定。 */
  active: boolean;
  /** 被组节点入口选中（只对组记录有意义）。 */
  selected?: boolean;
  actions: ActivityRowActions;
  source: ActivityRowSource;
};

/** 宿主在装配时构造一次的来源能力（design D6）。 */
export type ActivityRowCapabilities = {
  /** 定位画布节点；组记录传入创作组根节点。 */
  locateNode?: (nodeId: string) => void;
  /** 打开该任务的详情；返回 `false` 表示该 run 没有 Agent 回合关联。 */
  openTaskDetail?: (item: ActivityFeedItem) => Promise<boolean> | boolean;
  /** 打开作品生成历史弹窗。 */
  openHistory?: (item: ActivityFeedItem) => void;
  /** 主/次行文案解析；缺省按 modelKey 兜底。 */
  resolveTaskDisplay?: (item: ActivityFeedItem) => { primary: string; secondary: string };
  /**
   * 节点渲染类型解析（`image`/`video`/`audio`/`text`…）。
   *
   * 只用于估算进度时长：任务记录缺 `modelType` 时按同一节点的类型兜底，避免节点与面板
   * 因为一个缺字段而落到不同估算时长（change: 2026-10-31-unify-node-and-activity-progress）。
   */
  resolveNodeType?: (nodeId: string) => string | undefined;
  group?: ActivityRowGroupCapabilities;
  /** Skill 媒体步骤（change: 2026-10-28-add-agent-skill-media-regeneration，任务 5.2）。 */
  skill?: ActivityRowSkillCapabilities;
};

/**
 * Skill 步骤投影能力。
 *
 * `refresh` 按步骤身份重读权威快照与事件重放，成功后把新快照交回 store
 * （`applySkillStep`），用于断线恢复后补齐旧尝试的真实终态。它只读，不重新提交生成；
 * 失败记录按终态呈现，不再额外暴露「核对状态」动作。
 */
export type ActivityRowSkillCapabilities = {
  refresh?: (step: SkillMediaStepView) => Promise<void>;
  resolveTitle?: (nodeId: string) => string;
};

export type ActivityRowGroupCapabilities = {
  action?: (run: CanvasGroupRun, action: "stop" | "retry") => Promise<void>;
  openConversation?: (run: CanvasGroupRun) => void | Promise<void>;
  writable?: () => boolean;
  resolveTitle?: (nodeId: string) => string;
};

/** 任务状态文案。 */
export const TASK_STATE_LABELS: Record<CanvasTaskActivity["state"], string> = {
  queued: "排队中",
  pending: "准备中",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

/** 后台活动状态文案。 */
export const BACKGROUND_STATUS_LABELS: Record<BackgroundActivityJob["status"], string> = {
  queued: "排队中",
  running: "录制中",
  succeeded: "已录制",
  failed: "失败",
  cancelled: "已取消"
};

/** 后台活动种类文案。 */
export const BACKGROUND_KIND_LABELS: Record<BackgroundActivityJob["kind"], string> = {
  "shot-reference-recording": "录制镜头参考"
};

/** 任务状态 → 语义色。 */
export const TASK_STATE_TONES: Record<CanvasTaskActivity["state"], ActivityRowTone> = {
  queued: "active",
  pending: "active",
  running: "active",
  succeeded: "success",
  failed: "danger",
  cancelled: "muted"
};

/** 后台活动状态 → 语义色。 */
export const BACKGROUND_STATUS_TONES: Record<BackgroundActivityJob["status"], ActivityRowTone> = {
  queued: "active",
  running: "active",
  succeeded: "success",
  failed: "danger",
  cancelled: "muted"
};

/**
 * 组创作状态 → 语义色。失败与部分完成都按终态显示，不保留「待核对」阶段。
 */
export function groupRunTone(status: string): ActivityRowTone {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "partial") return "danger";
  if (status === "cancelled") return "muted";
  return "active";
}

/** 组记录仍可停止的运行状态（宿主侧语义）。 */
export const GROUP_STOPPABLE_STATUSES = ["queued", "running", "committing"] as const;

/** Skill 尝试状态文案（活动面板；`superseded` 是宿主语义，不等于 Provider 已取消）。 */
export const SKILL_STATE_LABELS: Record<SkillMediaStepView["attempts"][number]["state"], string> = {
  queued: "排队中",
  running: "生成中",
  "cancel-requested": "取消中",
  cancelled: "已取消",
  superseded: "已替代",
  succeeded: "已完成",
  failed: "失败"
};

export function skillStateTone(state: SkillMediaStepView["attempts"][number]["state"]): ActivityRowTone {
  if (state === "succeeded") return "success";
  if (state === "failed") return "danger";
  if (state === "cancelled" || state === "superseded") return "muted";
  return "active";
}

export function skillStateActive(state: SkillMediaStepView["attempts"][number]["state"]): boolean {
  return state === "queued" || state === "running" || state === "cancel-requested";
}

/** 进度只在进行中显示，并按 0..1 夹紧；缺失时保留 undefined（不伪造百分比）。 */
export function clampProgress(progress: number | undefined): number | undefined {
  if (progress === undefined) return undefined;
  return Math.max(0, Math.min(1, progress));
}

/**
 * 规范上报进度 → 真正的 0..1 分数（缺失时 `undefined`，不伪造）。
 *
 * 契约要求 `progress` 是 0..1，但历史与部分 Provider 会夹带 0..100 的百分比。直接
 * `clampProgress` 会把 `42` 夹成 `1`（100%），而节点读模型按 `42%` 处理 —— 同一任务在面板与
 * 节点上就会显示 `95%` 与 `42%`。这里先按 `reportedProgressPercent` 归一，再折回分数，
 * 与节点侧用的是同一条换算（change: 2026-10-31-unify-node-and-activity-progress）。
 */
export function fractionProgress(progress: number | undefined): number | undefined {
  const percent = reportedProgressPercent(progress);
  return percent === undefined ? undefined : percent / 100;
}

/**
 * 行在面板上显示的整数百分比（与画布节点进度环同一个公式）
 * （change: 2026-10-31-unify-node-and-activity-progress，design D1/D2）。
 *
 * 生成任务：节点与面板共享「该 run 的创建时刻」作为估算起点，再用同一套按种类的估算时长与
 * `max(估算, 上报)` 规则取整，因此两边显示同一个数字，而不是一个显示服务端上报、另一个显示
 * 时间推算。其他来源（扩展后台活动）没有画布进度环，只按自己的上报值显示。
 *
 * `now` 由调用方传入（面板每秒 tick 一次，测试注入固定值），本函数仍是纯的。
 * 终态返回 `undefined`（终态不再展示进度）。
 */
export function displayedProgressPercent(
  row: ActivityRow,
  now: number,
  capabilities: ActivityRowCapabilities = {}
): number | undefined {
  if (!row.active) return undefined;
  if (row.kind !== "task") {
    const percent = reportedProgressPercent(row.progress);
    return percent === undefined ? undefined : Math.round(percent);
  }
  const item = row.source.kind === "task" ? row.source.item : undefined;
  const reported = row.progress;
  // 只有乐观记录（缺少可解析的创建时刻）时没有起点可算：退回上报值，绝不编造时间进度。
  if (!Number.isFinite(Date.parse(row.createdAt))) {
    const percent = reportedProgressPercent(reported);
    return percent === undefined ? undefined : Math.round(percent);
  }
  // 节点侧按自身的渲染类型（text/image/video/audio）估时长；任务记录缺 `modelType` 时用
  // 同一节点的类型兜底，避免同一任务在两端落到不同估算时长。
  const kind = item?.modelType ?? (item?.nodeId ? capabilities.resolveNodeType?.(item.nodeId) : undefined);
  return roundedGenerationPercent({
    startedAt: row.createdAt,
    ...(reported !== undefined ? { reported } : {}),
    ...(kind !== undefined ? { kind } : {}),
    now
  });
}

/** 面板排序：开始时间从新到旧，同时刻用稳定 key 兜底（design D7）。 */
export function compareRows(a: ActivityRow, b: ActivityRow): number {
  if (a.createdAt === b.createdAt) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  return a.createdAt > b.createdAt ? -1 : 1;
}
