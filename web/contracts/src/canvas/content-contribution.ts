/**
 * 扩展内容贡献（change: 2026-10-26-abstract-extension-content-fields）。
 *
 * 注册表实例就是页面或站点作用域，不使用模块级单例。内核函数只接收只读 resolver；
 * 写入、命令、编辑、复制、迁移、交互与路由都按 owner 分派，缺省空解析器保持既有只读行为。
 */
import type { CanvasAuthority } from "../backend/canvas-authority.js";
import type { McpApplyCommandsResult, McpGetNodeResult } from "./mcp-internal.js";
import type { ServerCanvas } from "./domain/index.js";
import type { EditOperation, EditPrecondition } from "./edit-command.js";

const EXTENSION_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

export type ContentDiagnostic = { readonly code: string; readonly reason: string };

/** 通用内容 owner id（稳定的扩展 id 语法，不绑定具体业务）。 */
export type ContentOwnerId = string;

/** 通用局部变换：位置/旋转/缩放由 owner 解释，宿主只做结构传递。 */
export type ContentLocalTransform = {
  readonly offset: { readonly x: number; readonly y: number; readonly z: number };
  readonly scale: number;
  readonly yaw: number;
};

export type ContentCopyContext = {
  readonly nodeIds: ReadonlyMap<string, string>;
  createId(prefix: string, index: number): string;
};

/**
 * 代码在宿主里的调用位置。owner codec 可据此做比「字段形状」更严的前置条件校验
 * （例如检查引用的资产仍存在、来源节点未被并发改写），而内核不需要知道业务字段名。
 */
export type ContentNodeContext = {
  readonly nodeId?: string;
  readonly nodeType?: string;
  /** 当前权威画布（只读）；跨画布粘贴时为目标画布。 */
  readonly canvas?: ServerCanvas;
};

export type ContentNodeDataCodec = {
  decode(data: unknown, context?: ContentNodeContext): { ok: true; value: unknown } | { ok: false; code: string; reason: string };
  validatePatch(previous: unknown, patch: unknown, context?: ContentNodeContext): ContentDiagnostic | null;
  normalize(data: unknown, context?: ContentNodeContext): unknown;
  sanitizeRuntime(data: unknown, context?: ContentNodeContext): unknown;
  copy(nodeData: unknown, context: ContentCopyContext): { data: unknown; assetRefs: readonly string[]; remap: Readonly<Record<string, string>> };
  diff(before: unknown, after: unknown, context: ContentCopyContext):
    | { ok: true; forward: unknown; inverse: unknown }
    | { ok: false; code: string; reason: string };
  inspect?(data: unknown, context?: ContentNodeContext): { ok: true; report: unknown } | { ok: false; code: string; reason: string };
};

export type ContentCommandEnvelope = {
  readonly extensionId: string;
  readonly nodeId?: string;
  readonly kind: string;
  readonly payload: unknown;
};

export type ContentCommandCodec = {
  readonly kinds: readonly string[];
  /** 过渡代认领的旧命令 type。内核据此分派，不写死业务名。 */
  readonly legacyTypes?: readonly string[];
  decode(command: ContentCommandEnvelope): { ok: true; value: unknown } | { ok: false; code: string; reason: string };
  apply(value: unknown, canvas: ServerCanvas): { ok: true; canvas: ServerCanvas } | { ok: false; code: string; reason: string };
  satisfied(value: unknown, canvas: ServerCanvas): boolean;
};

export type ContentEditApplication = {
  readonly direction: "forward" | "inverse";
  readonly edit: unknown;
  readonly preconditions: readonly unknown[];
  readonly canvas: ServerCanvas;
};

/** owner 专属编辑段：载荷与条件对内核不透明，经 canonical `extension.edit` 原子应用。 */
export type ContentEditOwnerSegment = {
  readonly extensionId: string;
  readonly direction: "forward" | "inverse";
  readonly edit: unknown;
  readonly preconditions: readonly unknown[];
};

/**
 * 规划出的一步编辑：先执行内核通用前置条件与结构操作，再应用 owner 段。
 * 整步在同一命令批次内结算，任一步失败都不得留下半提交。
 */
export type ContentEditStep = {
  readonly preconditions: readonly EditPrecondition[];
  readonly operations: readonly EditOperation[];
  readonly extensions?: readonly ContentEditOwnerSegment[];
};

export type ContentEditPlan = {
  readonly forward: ContentEditStep;
  readonly inverse: ContentEditStep;
};

export type ContentEditPlanner = {
  /**
   * 认领节点（节点类型 + nodeData）。缺省只认 `composite-asset` 且 `extensionId` 等于本 owner。
   * owner 据此把业务字段净差异从内核通用规划中移出。
   */
  matchesNode?(type: string, data: unknown): boolean;
  /** owner 规划前向/逆向差异；可同时产出通用结构操作与 owner 专属段。 */
  plan(before: ServerCanvas, after: ServerCanvas):
    | { ok: true; plan: ContentEditPlan }
    | { ok: false; code: string; reason: string };
  /** 内核执行 owner 提供的前向/逆向编辑；必须整次成功或整次失败。 */
  apply(input: ContentEditApplication): { ok: true; canvas: ServerCanvas } | { ok: false; code: string; reason: string };
  /** 命令 satisfied 判定；省略时视为已满足（无法复核）。 */
  satisfied?(input: ContentEditApplication): boolean;
};

/**
 * 扩展呈现适配器（change: 2026-10-28-generic-extension-content-ownership，任务 4.3）。
 *
 * owner 把业务载荷投影为 render-scene 的通用原语（预览卡片/归属线/运行反馈/受管条目/媒体
 * 平面）。宿主只合并、校验与去重；Rust 不感知扩展 id 或业务字段名。未知原语/版本被丢弃，
 * 不影响同帧其它节点。
 */
export type ContentPresentationAdapter = {
  /**
   * 为整张画布派生通用原语；不适用时返回 null。
   *
   * `localStates` 是宿主已校验的本地呈现态（键为卡片节点 id），只承载本地播放/准备状态；
   * `projectEntityAnchor` 把 owner 内条目的相机姿态投影为画布 2D 点（缺失即不派生归属线）。
   */
  presentPrimitives(input: ContentPresentationContext): import("./render-scene/wire-primitives.js").ContentPresentationPrimitives | null;
};

/** 呈现适配器输入：只读画布 + 宿主已解析的本地输入。 */
export type ContentPresentationContext = {
  readonly canvas: ServerCanvas;
  /** 卡片节点 id → 本地呈现态（`state`/`progress`/`playing`/`diagnostic`）。 */
  readonly localStates?: Readonly<Record<string, unknown>>;
  /** owner + 实体 → 画布 2D 锚点；缺失即不派生归属线起点。 */
  readonly projectEntityAnchor?: (ownerNodeId: string, entityId: string) => { readonly x: number; readonly y: number } | null;
};

export type ContentInteractionPolicy = {
  isManagedNode(type: string, data: unknown): boolean;
  selectionActions(action: "delete" | "copy" | "cut" | "rename" | "group" | "download" | "convert", type: string, data: unknown): { allowed: true } | { allowed: false; reason: string };
  hoverPlaybackTarget(type: string, data: unknown): { ownerNodeId: string; entityId: string } | null;
  doubleClickTarget(type: string, data: unknown): { kind: string; nodeId: string; entityId?: string } | null;
};

export type ContentMigration = {
  readonly extensionId: string;
  readonly from: number;
  readonly to: number;
  migrate(data: unknown): unknown;
};

export type ContentRouteResult = { readonly status: number; readonly body?: unknown };

export type ContentRoute = {
  readonly method: string;
  readonly path: readonly string[];
  handle(request: { readonly body: unknown }): ContentRouteResult | Promise<ContentRouteResult>;
};

/**
 * 内容 owner MCP 工具的可信调用上下文。
 *
 * owner 只拿通用权威端口：读节点、提交命令、解析房间。canvasId/subject/permission 由宿主认证
 * 与画布授权链给出，工具参数不得自报这些身份。
 */
export type ContentMcpToolContext = {
  readonly extensionId: string;
  readonly subject?: string;
  readonly actorId?: string;
  readonly permission: "read" | "write";
  resolveRoom(canvasId: string): Promise<CanvasAuthority | null>;
  readNode?(input: { canvasId: string; nodeId: string; resource?: "group-appearance"; includeStatistics?: boolean }): Promise<McpGetNodeResult>;
  applyCommands?(input: { canvasId: string; commandId: string; baseRevision: number; commands: import("./commands.js").CanvasCommand[] }): Promise<McpApplyCommandsResult>;
  /** 宿主原生录制端口；缺失表示纯浏览器宿主。 */
  recording?(): import("./content-recording-port.js").CanvasRecordingPort | undefined;
  themeBackdrop?(): string;
};

export type ContentMcpTool = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: unknown;
  /** 工具是否改变画布；缺省按写工具处理。 */
  readonly permission?: "read" | "write";
  /** MCP 目录参数形状；与 `inputSchema` 二选一，供宿主生成 zod schema。 */
  readonly parameters?: Readonly<Record<string, { readonly type: "string" | "strings" | "object"; readonly optional?: boolean; readonly maxLength?: number; readonly description?: string }>>;
  /** 可选：转发到 owner 内容路由而不是直接调用 `handle`。 */
  readonly route?: { readonly method: string; readonly path: readonly string[] };
  authorize?(input: unknown): ContentDiagnostic | null;
  /**
   * 额外授权范围：工具参数里出现基础授权未覆盖的资源 id 时（例如 duplicate 的目标 clip），
   * owner 返回它，宿主会用同一 grant 再做一次范围校验。
   */
  grantArgs?(input: unknown): { canvasId?: string; nodeId?: string; clipId?: string; itemId?: string; cameraId?: string } | null;
  handle(input: unknown, context: ContentMcpToolContext): { ok: boolean; text?: string; structured?: unknown } | Promise<{ ok: boolean; text?: string; structured?: unknown }>;
};

/**
 * 序列化的 owner 定位声明（change: 2026-10-28-generic-extension-content-ownership，任务 1.2）。
 *
 * 只声明「哪类节点上的哪个字段属于我」；字段存在不等于可信，不提供写授权。宿主据此在
 * 贡献停用/缺失时仍能识别持久数据并保留字段。`fields` 是显式身份字段，不是 `ownedFields`
 * 的耦合清单。
 */
export type ContentNodeLocator = {
  readonly nodeTypes: readonly string[];
  readonly fields: readonly string[];
};

export type ContentVersionAccessor = {
  /** 读取 owner 自己的版本字段；缺失/不支持时返回 null。 */
  read(data: unknown): number | null;
  /** 写入迁移后的版本；返回新的规范 nodeData。 */
  write(data: unknown, version: number): unknown;
};

export type ContentContribution = {
  readonly extensionId: string;
  /** 扩展声明、由宿主校验唯一性的 Agent 目标 mode（业务白名单不进入内核）。 */
  readonly targetModes?: readonly string[];
  /** 扩展声明、由宿主校验唯一性的领域事件 owner id。 */
  readonly eventOwners?: readonly string[];
  /** 序列化的节点定位声明；停用后可由持久元数据继续识别已有内容。 */
  readonly ownerLocators?: readonly ContentNodeLocator[];
  readonly nodeData?: ContentNodeDataCodec;
  readonly commands?: ContentCommandCodec;
  readonly edit?: ContentEditPlanner;
  readonly presentation?: ContentPresentationAdapter;
  readonly interaction?: ContentInteractionPolicy;
  readonly migrations?: readonly ContentMigration[];
  /** owner 版本字段访问器；声明 migrations 时必需。 */
  readonly version?: ContentVersionAccessor;
  readonly routes?: readonly ContentRoute[];
  readonly mcpTools?: readonly ContentMcpTool[];
};

export type ContentContributionResolver = {
  resolve(extensionId: string): ContentContribution | null;
  implementations(): readonly ContentContribution[];
  targetModes?(): readonly string[];
  eventOwners?(): readonly string[];
  /** 最近已验证的定位声明；贡献停用后仍保留，供只读识别已有内容。 */
  locators?(): readonly { readonly extensionId: string; readonly ownerLocators: readonly ContentNodeLocator[] }[];
};

export const EMPTY_CONTENT_RESOLVER: ContentContributionResolver = {
  resolve: () => null,
  implementations: () => []
};

/** 基座阶段只接收解析器。后续阶段才按 owner 分派。 */
export function observeContentResolver(resolver: ContentContributionResolver | undefined): void {
  void resolver;
}

export type ContentWriteDecision =
  | { ok: true; extensionId: string }
  | { ok: false; extensionId: string; code: string };

/**
 * 按注册表决定一次业务写入。未注册或缺少 codec 时稳定拒绝；codec 抛错不把异常文本写进结果。
 */
export function decideContentWrite(
  extensionId: string,
  previous: unknown,
  patch: unknown,
  content: ContentContributionResolver,
  context?: ContentNodeContext
): ContentWriteDecision {
  const codec = content.resolve(extensionId)?.nodeData;
  if (!codec) return { ok: false, extensionId, code: "content-owner-unavailable" };
  try {
    const diagnostic = codec.validatePatch(previous, patch, context);
    if (diagnostic) return { ok: false, extensionId, code: diagnostic.code };
    return { ok: true, extensionId };
  } catch {
    return { ok: false, extensionId, code: "content-codec-failed" };
  }
}

/** 过渡期：找到认领旧命令 type 的 owner；找不到时由内核兼容路径处理。 */
export function findContentCommandOwnerForLegacyType(
  content: ContentContributionResolver | undefined,
  type: string
): ContentContribution | null {
  if (!content) return null;
  for (const contribution of content.implementations()) {
    if (contribution.commands?.legacyTypes?.includes(type)) return contribution;
  }
  return null;
}

/** 只读解析 owner 的 nodeData codec；未注册或该 owner 没声明 codec 时返回 null。 */
export function resolveContentNodeCodec(
  content: ContentContributionResolver | undefined,
  extensionId: string | null | undefined
): ContentNodeDataCodec | null {
  if (!content || !extensionId) return null;
  const owner = content.resolve(extensionId);
  return owner?.nodeData ?? null;
}

function fail(code: string): Error {
  return new Error(code);
}

function routeKey(route: ContentRoute): string {
  return `${route.method.toUpperCase()} ${route.path.join("/")}`;
}

function assertContribution(contribution: ContentContribution): void {
  if (!EXTENSION_ID.test(contribution.extensionId) || contribution.extensionId.length > 200) throw fail("content-registration-invalid");
  if (contribution.nodeData) {
    for (const name of ["decode", "validatePatch", "normalize", "sanitizeRuntime", "copy", "diff"] as const) {
      if (typeof contribution.nodeData[name] !== "function") throw fail("content-registration-invalid");
    }
  }
  for (const locator of contribution.ownerLocators ?? []) {
    if (!Array.isArray(locator.nodeTypes) || locator.nodeTypes.length === 0 || new Set(locator.nodeTypes).size !== locator.nodeTypes.length) {
      throw fail("content-registration-invalid");
    }
    if (!Array.isArray(locator.fields) || locator.fields.length === 0 || new Set(locator.fields).size !== locator.fields.length) {
      throw fail("content-registration-invalid");
    }
    if (locator.nodeTypes.some((type) => typeof type !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(type))) throw fail("content-registration-invalid");
    if (locator.fields.some((field) => typeof field !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(field))) throw fail("content-registration-invalid");
  }
  if (contribution.edit) {
    if (typeof contribution.edit.plan !== "function" || typeof contribution.edit.apply !== "function") throw fail("content-registration-invalid");
  }
  if (contribution.commands) {
    const kinds = contribution.commands.kinds;
    if (!Array.isArray(kinds) || kinds.length === 0 || new Set(kinds).size !== kinds.length || kinds.some((kind) => typeof kind !== "string" || kind.length === 0)) {
      throw fail("content-registration-invalid");
    }
    for (const name of ["decode", "apply", "satisfied"] as const) {
      if (typeof contribution.commands[name] !== "function") throw fail("content-registration-invalid");
    }
  }
  if (contribution.migrations && contribution.migrations.length > 0) {
    if (!contribution.version || typeof contribution.version.read !== "function" || typeof contribution.version.write !== "function") {
      throw fail("content-registration-invalid");
    }
    for (const migration of contribution.migrations) {
      if (!Number.isInteger(migration.from) || !Number.isInteger(migration.to) || migration.to <= migration.from || typeof migration.migrate !== "function") {
        throw fail("content-registration-invalid");
      }
    }
  }
  const toolNames = new Set<string>();
  for (const tool of contribution.mcpTools ?? []) {
    if (!tool.name || toolNames.has(tool.name) || typeof tool.handle !== "function") throw fail("content-registration-invalid");
    toolNames.add(tool.name);
  }
  const routes = new Set<string>();
  for (const route of contribution.routes ?? []) {
    const key = routeKey(route);
    if (!route.method || route.path.length === 0 || route.path.some((segment) => !segment || segment.includes("/")) || routes.has(key) || typeof route.handle !== "function") {
      throw fail("content-registration-invalid");
    }
    routes.add(key);
  }
}

/** 一个页面或站点作用域内的内容贡献。 */
export class ContentContributionRegistry implements ContentContributionResolver {
  private readonly entries = new Map<string, ContentContribution>();
  private readonly cache = new Map<string, ContentContribution | null>();
  private readonly tools = new Map<string, string>();
  private readonly retainedLocators = new Map<string, readonly ContentNodeLocator[]>();

  register(contribution: ContentContribution): () => void {
    assertContribution(contribution);
    if (this.entries.has(contribution.extensionId)) throw fail("content-registration-conflict");
    for (const tool of contribution.mcpTools ?? []) {
      if (this.tools.has(tool.name)) throw fail("content-tool-conflict");
    }
    this.entries.set(contribution.extensionId, contribution);
    if (contribution.ownerLocators?.length) this.retainedLocators.set(contribution.extensionId, contribution.ownerLocators);
    else this.retainedLocators.delete(contribution.extensionId);
    for (const tool of contribution.mcpTools ?? []) this.tools.set(tool.name, contribution.extensionId);
    this.cache.delete(contribution.extensionId);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.entries.get(contribution.extensionId) !== contribution) return;
      this.entries.delete(contribution.extensionId);
      for (const tool of contribution.mcpTools ?? []) {
        if (this.tools.get(tool.name) === contribution.extensionId) this.tools.delete(tool.name);
      }
      this.cache.delete(contribution.extensionId);
    };
  }

  /** 中途失败时按注册的反序释放本次已发布的贡献。 */
  activate(contributions: readonly ContentContribution[]): () => void {
    const releases: Array<() => void> = [];
    try {
      for (const contribution of contributions) releases.push(this.register(contribution));
    } catch (error) {
      for (let index = releases.length - 1; index >= 0; index -= 1) releases[index]!();
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (let index = releases.length - 1; index >= 0; index -= 1) releases[index]!();
    };
  }

  /** 按扩展与 `METHOD path` 查内容路由；未注册返回 null。 */
  route(extensionId: string, method: string, path: readonly string[]): ContentRoute | null {
    const owner = this.entries.get(extensionId);
    if (!owner) return null;
    const key = `${method.toUpperCase()} ${path.join("/")}`;
    return owner.routes?.find((route) => routeKey(route) === key) ?? null;
  }

  /** 内容 MCP 工具目录（按名称唯一，停用后自动消失）。 */
  mcpTool(name: string): { contribution: ContentContribution; tool: ContentMcpTool } | null {
    const extensionId = this.tools.get(name);
    if (!extensionId) return null;
    const contribution = this.entries.get(extensionId);
    const tool = contribution?.mcpTools?.find((entry) => entry.name === name);
    return contribution && tool ? { contribution, tool } : null;
  }

  mcpCatalog(): readonly ContentMcpTool[] {
    return this.implementations().flatMap((contribution) => contribution.mcpTools ?? []);
  }

  /** 当前 scope 活跃 owner 声明的 Agent target mode 目录（去重、稳定排序）。 */
  locators(): readonly { readonly extensionId: string; readonly ownerLocators: readonly ContentNodeLocator[] }[] {
    return [...this.retainedLocators].map(([extensionId, ownerLocators]) => ({ extensionId, ownerLocators }));
  }

  targetModes(): readonly string[] {
    return [...new Set(this.implementations().flatMap((contribution) => contribution.targetModes ?? []))].sort();
  }

  /** 当前 scope 活跃 owner 声明的领域事件 owner 目录（去重、稳定排序）。 */
  eventOwners(): readonly string[] {
    return [...new Set(this.implementations().flatMap((contribution) => contribution.eventOwners ?? []))].sort();
  }

  resolve(extensionId: string): ContentContribution | null {
    if (this.cache.has(extensionId)) return this.cache.get(extensionId) ?? null;
    const found = this.entries.get(extensionId) ?? null;
    this.cache.set(extensionId, found);
    return found;
  }

  implementations(): readonly ContentContribution[] {
    return [...this.entries.values()].sort((left, right) => left.extensionId.localeCompare(right.extensionId));
  }
}
