/**
 * Frontend Dialog contracts（change: add-frontend-dialog-system，任务 1.1 / design D2）。
 *
 * 纯类型与校验：不导入 React 或 React DOM。Dialog Host stack 只保存**类型化 descriptor**
 * （不保存 ReactNode / DOM / 业务闭包），renderer 由 registry 按 `dialogId` 解析。
 */

/** 弹窗视觉/布局变体。 */
export type DialogVariant = "standard" | "alert" | "media" | "sheet";
/** 弹窗尺寸档位。 */
export type DialogSize = "sm" | "md" | "lg" | "fullscreen";

/** 一个已入栈弹窗实例的描述符（纯数据，可序列化）。 */
export type DialogInstance = {
  /** 稳定实例身份；异步回调据此忽略迟到结果。 */
  instanceId: string;
  /** 注册的 dialog 类型。 */
  dialogId: string;
  /** 通过 validator 的 payload。 */
  payload: unknown;
  /** 打开时 stack 顶部的实例；根弹窗为 `null`。 */
  parentInstanceId: string | null;
  /** 是否允许 Escape / 遮罩 / 关闭按钮关闭。 */
  dismissible: boolean;
  /** busy 时禁止隐式关闭与重复确认。 */
  busy: boolean;
};

/** 打开请求：由业务功能提交，只携带类型化 payload。 */
export type OpenDialogRequest = {
  dialogId: string;
  payload?: unknown;
  /** 是否允许隐式关闭；缺省取 registry 声明。 */
  dismissible?: boolean;
  /**
   * singleton 语义：已存在同类实例时不堆叠，而是替换其 payload（design D2）。
   * 缺省取 registry 声明。
   */
  singleton?: boolean;
};

/** 类型化 payload 校验：返回规范化 payload 或错误信息。 */
export type PayloadValidator<T = unknown> = (
  payload: unknown
) => { ok: true; payload: T } | { ok: false; error: string };

/**
 * Trusted registration-only identity; never read from request payload.
 *
 * 节点文档带 `nodeId`；独立文件文档带 `documentId` 且没有画布节点身份
 * （编辑扩展工作区，D1/D7）。
 */
export type DialogEditingOwner = {
  canvasId: string;
  nodeId?: string;
  /** 独立文件文档的不透明 id（与 `nodeId` 互斥）。 */
  documentId?: string;
  sessionId: string;
};

/** registry 中一个 dialog 的声明。 */
export type DialogDefinition = {
  editingOwner?: () => DialogEditingOwner | null;
  /** 允许隐式关闭（Escape/遮罩/关闭按钮）。 */
  dismissible?: boolean;
  /** 同一时刻最多一个实例。 */
  singleton?: boolean;
  /** 校验并规范化 payload。 */
  validatePayload: PayloadValidator;
  /** 变体与尺寸（renderer 可覆盖）。 */
  variant?: DialogVariant;
  size?: DialogSize;
};

/** `open` 的结果；失败时带稳定诊断，调用方不应崩溃。 */
export type OpenDialogResult =
  | { ok: true; instance: DialogInstance }
  | { ok: false; error: string };

/**
 * Dialog open pre-commit participant（change: unify-canvas-presentation-navigation，design D4）。
 * 在合法请求通过纯校验后、stack 提交前同步运行；返回 false 时拒绝打开。
 */
export type DialogOpenParticipant = (request: { dialogId: string; payload?: unknown; editingOwner?: DialogEditingOwner }) => boolean;

/**
 * 关闭请求 guard（change: 2026-10-17-move-settings-into-canvas-dialog，任务 3.2）。
 *
 * `requestClose` 供 Host 在 Escape、遮罩、Header 关闭按钮与业务关闭请求时调用；返回：
 * - `allow`：按 Host 默认策略关闭；
 * - `handled`：guard 已接管本次请求（例如弹出「继续编辑 / 放弃修改」确认，或因写请求进行中
 *   直接拒绝），Host MUST NOT 关闭该实例。
 *
 * guard 按 `dialogId` 注册、按 instanceId 调用；不保存 React 闭包到 dialog payload。
 */
export type DialogCloseGuardRequest = "allow" | "handled";

export type DialogCloseGuard = (instance: DialogInstance) => DialogCloseGuardRequest;

export type DialogCloseResult = {
  closed: boolean;
  instanceId: string | null;
  /** guard 接管了本次请求（未关闭）。 */
  handled?: boolean;
};

/** Host 对外 API（store 实现，renderer/业务使用）。 */
export type DialogHostApi = {
  open(request: OpenDialogRequest): OpenDialogResult;
  /** 替换指定实例（缺省为顶部）的 payload；instanceId 不匹配时不动作。 */
  replace(payload: unknown, instanceId?: string): boolean;
  /** 关闭指定实例及其显式子孙；缺省关闭顶部。 */
  close(instanceId?: string): boolean;
  closeTop(): boolean;
  /**
   * 请求关闭（缺省顶部）：统一走 dismissible / busy / close guard 判定，
   * 不绕过 guard 直接关闭（change: 2026-10-17-move-settings-into-canvas-dialog 任务 3.2）。
   */
  requestClose(instanceId?: string): DialogCloseResult;
  /** 更新 busy；已关闭实例的迟到调用被忽略（返回 false）。 */
  setBusy(instanceId: string, busy: boolean): boolean;
};
