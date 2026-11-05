/**
 * 扩展内容贡献（change: 2026-10-26-abstract-extension-content-fields）。
 *
 * 注册表实例就是页面或站点作用域，不使用模块级单例。内核函数只接收只读 resolver；
 * 已接入的命令与 composite nodeData 按 owner 分派；未提供 resolver 的作用域保留阶段性兼容行为。
 */
import type { ServerCanvas } from "./domain/index.js";

const EXTENSION_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

export type ContentDiagnostic = { readonly code: string; readonly reason: string };

export type ContentCopyContext = {
  readonly nodeIds: ReadonlyMap<string, string>;
  createId(prefix: string, index: number): string;
};

export type ContentNodeDataCodec = {
  decode(data: unknown): { ok: true; value: unknown } | { ok: false; code: string; reason: string };
  validatePatch(previous: unknown, patch: unknown): ContentDiagnostic | null;
  normalize(data: unknown): unknown;
  sanitizeRuntime(data: unknown): unknown;
  copy(nodeData: unknown, context: ContentCopyContext): { data: unknown; assetRefs: readonly string[]; remap: Readonly<Record<string, string>> };
  diff(before: unknown, after: unknown, context: ContentCopyContext):
    | { ok: true; forward: unknown; inverse: unknown }
    | { ok: false; code: string; reason: string };
  /** 业务内容版本。认领不了时返回 null。 */
  schemaVersion?(data: unknown): number | null;
  /** 旧业务形态禁止新建或普通写入。不是这种数据时返回 null。 */
  rejectLegacy?(type: string | undefined, data: unknown): ContentDiagnostic | null;
  inspect?(data: unknown): { ok: true; report: unknown } | { ok: false; code: string; reason: string };
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

export type ContentEditPlanner = {
  /** Expand an opaque edit into bounded, non-recursive protected structure operations. */
  expand?(input: { readonly nodeId: string; readonly op: unknown }): unknown;
  plan(before: ServerCanvas, after: ServerCanvas):
    | { ok: true; forward: unknown; inverse: unknown; preconditions: readonly unknown[] }
    | { ok: false; code: string; reason: string };
};

export type ContentPresentationAdapter = {
  presentPrimitives(input: { readonly nodeId: string; readonly data: unknown }): unknown;
};

export type ContentInteractionPolicy = {
  isManagedNode(type: string, data: unknown): boolean;
  selectionActions(action: "delete" | "copy" | "cut" | "rename" | "download", type: string, data: unknown): { allowed: true } | { allowed: false; reason: string };
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

export type ContentMcpTool = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: unknown;
  authorize?(input: unknown): ContentDiagnostic | null;
  handle(input: unknown): { ok: boolean; text?: string; structured?: unknown } | Promise<{ ok: boolean; text?: string; structured?: unknown }>;
};

export type ContentContribution = {
  readonly extensionId: string;
  /** 该扩展当前写入的内容版本。低于它的数据按 migrations 顺序升级。 */
  readonly contentVersion?: number;
  readonly nodeData?: ContentNodeDataCodec;
  readonly commands?: ContentCommandCodec;
  readonly edit?: ContentEditPlanner;
  readonly presentation?: ContentPresentationAdapter;
  readonly interaction?: ContentInteractionPolicy;
  readonly migrations?: readonly ContentMigration[];
  readonly routes?: readonly ContentRoute[];
  readonly mcpTools?: readonly ContentMcpTool[];
};

export type ContentContributionResolver = {
  resolve(extensionId: string): ContentContribution | null;
  implementations(): readonly ContentContribution[];
};

export const EMPTY_CONTENT_RESOLVER: ContentContributionResolver = {
  resolve: () => null,
  implementations: () => []
};

/** 保留既有可选 context 接缝；各纯函数在支持的路径显式消费 resolver。 */
export function observeContentResolver(resolver: ContentContributionResolver | undefined): void {
  void resolver;
}

export type ContentWriteDecision =
  | { ok: true; extensionId: string }
  | { ok: false; extensionId: string; code: string };

export type ContentMigrationResult = {
  data: unknown;
  /** 版本过新或缺少到达当前版本的迁移时保留原数据，调用方不得按当前 schema 覆盖。 */
  readOnly: boolean;
  applied: number[];
};

/**
 * 按已注册迁移把一份 nodeData 升到扩展的 contentVersion。
 *
 * 已是当前版本时不改写。迁移抛错或结果版本不对时返回原数据且不记版本，下次可从同一边界重试。
 * 没有 codec 或认领不了版本的贡献跳过。
 */
export function migrateContentNodeData(data: unknown, content: ContentContributionResolver): ContentMigrationResult {
  const unchanged = { data, readOnly: false, applied: [] as number[] };
  for (const contribution of content.implementations()) {
    const read = contribution.nodeData?.schemaVersion;
    const target = contribution.contentVersion;
    if (!read || target === undefined) continue;
    let version: number | null;
    try {
      version = read(data);
    } catch {
      return { data, readOnly: true, applied: [] };
    }
    if (version === null) continue;
    if (!Number.isInteger(version) || version < 1 || version > target) return { data, readOnly: true, applied: [] };
    if (version === target) return unchanged;
    const steps = (contribution.migrations ?? [])
      .filter((migration) => migration.extensionId === contribution.extensionId)
      .sort((left, right) => left.from - right.from);
    let next = data;
    let cursor = version;
    const applied: number[] = [];
    while (cursor < target) {
      const step = steps.find((migration) => migration.from === cursor && migration.to === cursor + 1);
      if (!step) return { data, readOnly: true, applied: [] };
      try {
        const migrated = step.migrate(structuredClone(next));
        if (read(migrated) !== step.to) return { data, readOnly: false, applied: [] };
        next = migrated;
        cursor = step.to;
        applied.push(step.to);
      } catch {
        return { data, readOnly: false, applied: [] };
      }
    }
    return { data: next, readOnly: false, applied };
  }
  return unchanged;
}

/**
 * 按注册表决定一次业务写入。未注册或缺少 codec 时稳定拒绝；codec 抛错不把异常文本写进结果。
 */
export function decideContentWrite(
  extensionId: string,
  previous: unknown,
  patch: unknown,
  content: ContentContributionResolver
): ContentWriteDecision {
  const codec = content.resolve(extensionId)?.nodeData;
  if (!codec) return { ok: false, extensionId, code: "content-owner-unavailable" };
  try {
    const diagnostic = codec.validatePatch(previous, patch);
    if (diagnostic) return { ok: false, extensionId, code: diagnostic.code };
    return { ok: true, extensionId };
  } catch {
    return { ok: false, extensionId, code: "content-codec-failed" };
  }
}

function fail(code: string): Error {
  return new Error(code);
}

export type ContentRouteDispatchRequest = {
  readonly method: string;
  readonly extensionId: string;
  readonly path: readonly string[];
  readonly body: unknown;
  readonly authorized: boolean;
};

/** 按已注册路由分发。未知路径 404，未授权 401，处理失败或超时 503，不带出异常文本。 */
export async function dispatchContentRoute(
  content: ContentContributionResolver,
  request: ContentRouteDispatchRequest,
  options: { readonly timeoutMs?: number } = {}
): Promise<ContentRouteResult> {
  if (!request.authorized) return { status: 401, body: { code: "unauthorized" } };
  const route = content.resolve(request.extensionId)?.routes?.find((item) =>
    item.method.toUpperCase() === request.method.toUpperCase()
    && item.path.length === request.path.length
    && item.path.every((segment, index) => segment === request.path[index])
  );
  if (!route) return { status: 404, body: { code: "content-route-not-found" } };
  const timeoutMs = options.timeoutMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve(route.handle({ body: request.body })),
      new Promise<ContentRouteResult>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("content-route-timeout")), timeoutMs);
      })
    ]);
    if (!result || typeof result.status !== "number") return { status: 503, body: { code: "content-route-failed" } };
    return result;
  } catch (error) {
    const timeout = error instanceof Error && error.message === "content-route-timeout";
    return { status: 503, body: { code: timeout ? "content-route-timeout" : "content-route-failed" } };
  } finally {
    if (timer) clearTimeout(timer);
  }
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
    if (contribution.nodeData.schemaVersion !== undefined && typeof contribution.nodeData.schemaVersion !== "function") {
      throw fail("content-registration-invalid");
    }
    if (contribution.nodeData.rejectLegacy !== undefined && typeof contribution.nodeData.rejectLegacy !== "function") {
      throw fail("content-registration-invalid");
    }
  }
  if (contribution.contentVersion !== undefined && (!Number.isInteger(contribution.contentVersion) || contribution.contentVersion < 1)) {
    throw fail("content-registration-invalid");
  }
  const seenFrom = new Set<number>();
  for (const migration of contribution.migrations ?? []) {
    if (migration.extensionId !== contribution.extensionId || !Number.isInteger(migration.from) || !Number.isInteger(migration.to) || migration.to !== migration.from + 1 || migration.from < 1 || seenFrom.has(migration.from) || typeof migration.migrate !== "function") {
      throw fail("content-registration-invalid");
    }
    if (contribution.contentVersion !== undefined && migration.to > contribution.contentVersion) throw fail("content-registration-invalid");
    seenFrom.add(migration.from);
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
  private readonly routes = new Map<string, string>();

  register(contribution: ContentContribution): () => void {
    assertContribution(contribution);
    if (this.entries.has(contribution.extensionId)) throw fail("content-registration-conflict");
    for (const tool of contribution.mcpTools ?? []) {
      if (this.tools.has(tool.name)) throw fail("content-tool-conflict");
    }
    for (const route of contribution.routes ?? []) {
      if (this.routes.has(routeKey(route))) throw fail("content-route-conflict");
    }
    this.entries.set(contribution.extensionId, contribution);
    for (const tool of contribution.mcpTools ?? []) this.tools.set(tool.name, contribution.extensionId);
    for (const route of contribution.routes ?? []) this.routes.set(routeKey(route), contribution.extensionId);
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
      for (const route of contribution.routes ?? []) {
        if (this.routes.get(routeKey(route)) === contribution.extensionId) this.routes.delete(routeKey(route));
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
