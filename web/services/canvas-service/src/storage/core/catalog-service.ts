/**
 * Canvas Catalog Service（多画布目录组合）
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 1.2 / 1.3 / design D4）。
 *
 * 组合规则：
 * - 结构化 `CanvasRepository` 提供画布**存在性、创建时间、分页总数和候选集合**；
 * - 已 bootstrap 的画布，其 `title` / `revision` / `updatedAt` / `nodeCount` / `assetCount`
 *   取自服务端 published Yjs projection；
 * - 尚未 bootstrap 的画布（Yjs document 不存在）沿用结构化摘要，使新建画布立即可发现；
 * - Yjs 读取失败或已有 projection 非法时**整体失败**，绝不回退到可能陈旧的结构化标题
 *   （spec「Yjs projection 读取失败」）。
 *
 * 本模块不含数据库驱动、Yjs 依赖或 HTTP 框架：published projection 通过窄 port 注入。
 */
import type {
  CanvasSummary,
  CanvasListPage,
  CanvasCatalogOrigin,
  CanvasSyncState,
  ServerCanvas
} from "@woohaa3/contracts";
import {
  MAX_CANVAS_LIST_LIMIT,
  normalizeCanvasListQuery,
  type CanvasListQuery,
  type CanvasRepository
} from "./contracts.js";

/** 本机全量扫描的页大小（仓库 limit 上限）与页数上限。 */
const MAX_LOCAL_SCAN_PAGE = MAX_CANVAS_LIST_LIMIT;
const MAX_LOCAL_SCAN_PAGES = 50;
import { CanvasStorageError } from "./errors.js";

/**
 * published Yjs projection 的只读 port。
 *
 * 返回 `null` 表示对应 Yjs document 不存在（尚未 bootstrap）；读取失败必须抛错，而不是
 * 返回 null 或陈旧值。
 */
export type CanvasPublishedReader = {
  loadPublished(canvasId: string): Promise<ServerCanvas | null>;
};

/**
 * 一个**远端目录来源**。
 *
 * 目录是 provider 式的：本机存储永远在，远端来源按是否接入追加。接入了几个来源就要
 * 都生效——本地新建的画布与远端已有的画布出现在同一份列表里，同一个 id 只出现一次。
 *
 * 来源实现必须自己处理"远端不可用"：抛错会让整份目录失败，正确的是返回空列表并把
 * 原因交给 `describe()`（与 `canvas-upstream` provider 同一口径）。
 */
export type CanvasCatalogRemoteSource = {
  /** 稳定 id，例如 `remote:remote-server`。 */
  id: string;
  /** 面向用户的来源名（不含地址与令牌）。 */
  label: string;
  /** 该来源当前可见的画布摘要；不可用时返回空列表。 */
  list(): Promise<readonly RemoteCanvasSummary[]>;
  /**
   * 按 id 取一张**可能不在 `list()` 结果里**的摘要（可选）。
   *
   * 链接分享的画布不会出现在对方目录里，但拿到链接的人必须能打开它：`remoteSummary`
   * 按 id 取摘要时先问这个入口。返回 `null` 表示该来源没有这张画布（或对调用者不可见）；
   * 抛错按「这次没答案」处理并回退到 `list()` 扫描（兼容只有列表能力的来源）。
   */
  get?(canvasId: string): Promise<RemoteCanvasSummary | null>;
  /**
   * 按 id 回答调用者在这张画布上的内容权限（可选）。
   *
   * 与 `get` 的区别是**被拒绝也是答案**：远端明确拒绝时返回
   * `{ canRead: false, canWrite: false }`，而 `get` 只能返回 null（这次取不到）。
   * 省略或返回 null 表示来源没有答案，调用方按"未知"处理（不得据此判只读）。
   */
  access?(canvasId: string): Promise<import("@woohaa3/contracts").CanvasAccess | null>;
};

/** 远端来源能提供的字段；缺的字段由调用方补默认值。 */
export type RemoteCanvasSummary = {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
  createdAt?: string;
  nodeCount?: number;
  assetCount?: number;
  /** 调用者在这张画布上的内容权限；省略表示来源没有答案。 */
  access?: import("@woohaa3/contracts").CanvasAccess;
};

export type CanvasCatalogServiceOptions = {
  repository: CanvasRepository;
  published: CanvasPublishedReader;
  /**
   * 追加的远端目录来源。省略 = 纯本地部署，行为与之前完全一致（原分页路径）。
   * 提供时切换到**合并模式**：来源合计后统一排序分页。
   *
   * 传**函数**时每次列举都会重新求值——扩展后启用、之后才登录的部署必须走这条，
   * 否则接入远端那一刻之前构造的实例永远只有本地一半。
   */
  remoteSources?:
    | readonly CanvasCatalogRemoteSource[]
    | (() => readonly CanvasCatalogRemoteSource[]);
  /** 本机视角的同步状态；省略表示该部署没有接远端同步。 */
  syncStateOf?: (canvasId: string) => CanvasSyncState | undefined;
  /**
   * 这张画布是否属于远端（持久归属记录）。
   *
   * 只用于把"远端查不到"翻译成权限结论，见 `accessOf`：属于远端的画布被远端拒绝 =
   * 当前账号没有访问权限；纯本地画布被拒绝是正常的（它本来就没上传）。
   */
  isRemoteOwned?: (canvasId: string) => boolean;
};

export class CanvasCatalogService {
  private readonly repository: CanvasRepository;
  private readonly published: CanvasPublishedReader;
  /**
   * 远端来源的**解析函数**，不是解析结果。
   *
   * 存结果会把"接入远端"锁死在构造那一刻：宿主先装载 canvas、后激活扩展，构造时
   * 根本没有 provider，于是接口一直是纯本地；之后用户登录、扩展运行起来，目录也不会
   * 多出远端那一半——表现正是"接上了服务端，却看不到服务端已有的画布"。
   *
   * 这与同步上游凭据（`upstreamCredential.resolve()`）同一口径：来源是**每次列举时**
   * 现查的，登录 / 登出 / 扩展启停都在下一次列举时自然生效。
   */
  private readonly remoteSources: () => readonly CanvasCatalogRemoteSource[];
  private readonly syncStateOf: ((canvasId: string) => CanvasSyncState | undefined) | undefined;
  private readonly isRemoteOwned: ((canvasId: string) => boolean) | undefined;

  constructor(options: CanvasCatalogServiceOptions) {
    this.repository = options.repository;
    this.published = options.published;
    // 兼容旧的数组形态：包一层常量函数，调用方不必都改。
    const source = options.remoteSources;
    this.remoteSources = typeof source === "function" ? source : () => source ?? [];
    this.syncStateOf = options.syncStateOf;
    this.isRemoteOwned = options.isRemoteOwned;
  }

  /** 当前接入的远端来源名，供诊断与界面说明"这份目录来自哪"。 */
  remoteSourceLabels(): string[] {
    return this.remoteSources().map((source) => source.label);
  }

  /**
   * 分页目录：结构化分页 + 本页逐项投影覆盖。
   *
   * Yjs 读取失败/投影非法向上抛出稳定 `CanvasStorageError`，调用方不得回退结构化标题。
   */
  async listCanvases(query?: CanvasListQuery): Promise<CanvasListPage> {
    const normalized = normalizeCanvasListQuery(query);
    // 每次列举现查：登录/登出/扩展启停都会在这一次列举里生效（见 remoteSources 的说明）。
    const sources = this.remoteSources();
    if (sources.length === 0) {
      // 纯本地：保持原有"仓库分页 + 本页投影覆盖"路径，不引入内存合并的成本。
      const page = await this.repository.listCanvases(normalized);
      const items = await Promise.all(page.items.map((summary) => this.mergeSummary(summary)));
      return { items: items.map((item) => this.withSync(item)), total: page.total, offset: page.offset, limit: page.limit };
    }
    return this.mergeSources(normalized, sources);
  }

  /**
   * 合并模式：本地全量 + 各远端来源，去重后按 updatedAt 倒序统一分页。
   *
   * 为什么整份合并在内存里做：两个来源各自的分页无法拼成一份正确的 `offset`/`total`
   * （在 A 源的第 2 页与 B 源的第 1 页之间没有共同顺序）。个人工作区量级（几十到几百
   * 张）足够，换来的是"看到的总数就是全部"，而不是"翻到第三页才发现少了一半"。
   *
   * `ids` 白名单（资源授权）仍然生效：合并之后再过滤，避免把无权限的画布算进 total。
   */
  private async mergeSources(
    normalized: ReturnType<typeof normalizeCanvasListQuery>,
    sources: readonly CanvasCatalogRemoteSource[]
  ): Promise<CanvasListPage> {
    const { offset, limit, ids } = normalized;
    const allowed = ids ? new Set(ids) : null;
    const entries = new Map<string, { summary: CanvasSummary; origins: Set<CanvasCatalogOrigin> }>();

    for (const structured of await this.collectLocal(allowed)) {
      const merged = await this.mergeSummary(structured);
      entries.set(merged.id, { summary: merged, origins: new Set<CanvasCatalogOrigin>(["local"]) });
    }

    for (const source of sources) {
      let remote: readonly RemoteCanvasSummary[] = [];
      try {
        remote = await source.list();
      } catch {
        // 来源故障不得让整份目录失败：本地部分照常可见。
        remote = [];
      }
      for (const item of remote) {
        if (allowed && !allowed.has(item.id)) continue;
        const existing = entries.get(item.id);
        if (existing) {
          existing.origins.add("remote");
          // 两边都有：内容以本地 published projection 为准（本地是工作副本），
          // 但**权限只能来自远端**——本地不知道谁是作者、谁共享了链接。
          if (item.access !== undefined) existing.summary.access = item.access;
          continue;
        }
        entries.set(item.id, {
          summary: {
            id: item.id,
            title: item.title,
            revision: item.revision,
            updatedAt: item.updatedAt,
            createdAt: item.createdAt ?? item.updatedAt,
            nodeCount: item.nodeCount ?? 0,
            assetCount: item.assetCount ?? 0,
            ...(item.access === undefined ? {} : { access: item.access })
          },
          origins: new Set<CanvasCatalogOrigin>(["remote"])
        });
      }
    }

    const ordered = [...entries.values()].sort(
      (a, b) => b.summary.updatedAt.localeCompare(a.summary.updatedAt) || a.summary.id.localeCompare(b.summary.id)
    );
    const items = ordered.slice(offset, offset + limit).map(({ summary, origins }) => {
      const sources = [...origins].sort();
      /**
       * 没有链路状态时的缺省结论（本机视角）：
       * - 只在远端有 → 本机还没有内容副本，界面显示「仅远端」，点开才落地；
       * - 两边都有 → 这张画布已经在远端，界面显示「已同步」（链路未加载时不必再问一次）；
       * - 只在本地 → 「仅本机」。是否提供「同步远端」动作由接入方按它自己的会话状态决定。
       */
      const defaultSync: CanvasSummary["sync"] = sources.includes("local")
        ? sources.includes("remote")
          ? "synced"
          : "local-only"
        : "remote-only";
      const marked: CanvasSummary = {
        ...summary,
        sources,
        sync: this.syncStateOf?.(summary.id) ?? defaultSync
      };
      return marked;
    });
    return { items, total: ordered.length, offset, limit };
  }

  /**
   * 取本机全部画布。
   *
   * 仓库接口的 limit 有上限（100），单次调用拿不到全量，因此按页扫到 `total` 为止。
   * 设一个页数上限作为防呆：真到那个量级时"内存合并"这个做法本身就该换掉了，
   * 宁可截断并让 total 偏小，也不要无限循环。
   */
  private async collectLocal(allowed: Set<string> | null): Promise<CanvasSummary[]> {
    const pageSize = MAX_LOCAL_SCAN_PAGE;
    const out: CanvasSummary[] = [];
    for (let page = 0; page < MAX_LOCAL_SCAN_PAGES; page += 1) {
      const result = await this.repository.listCanvases({ offset: page * pageSize, limit: pageSize, ...(allowed ? { ids: [...allowed] } : {}) });
      out.push(...result.items.filter((item) => !allowed || allowed.has(item.id)));
      if (out.length >= result.total || result.items.length === 0) break;
    }
    return out;
  }

  /**
   * 按 id 取**来源摘要**（不读内容）。
   *
   * 用于"远端有、本机还没有"的画布：目录里要能打开它，而本地仓库还没有行。
   * 返回值只用于目录展示与打开前的存在性判定，内容由 room 从上游拉取。
   */
  async remoteSummary(canvasId: string): Promise<RemoteCanvasSummary | null> {
    for (const source of this.remoteSources()) {
      // 链接分享的画布不在任何人的目录里：按 id 问来源是**唯一**能找到它的方式。
      // 有 get 就以它为准（返回 null = 这个来源确实没有这张画布，不再多列一次目录）。
      if (typeof source.get === "function") {
        try {
          const found = await source.get(canvasId);
          if (found) return found;
          continue;
        } catch {
          // 按 id 取失败不变成"这张画布不存在"：回退到列表扫描（与合并路径同一口径）。
        }
      }
      try {
        const found = (await source.list()).find((item) => item.id === canvasId);
        if (found) return found;
      } catch {
        // 与合并路径同一口径：来源故障不变成"这张画布不存在"。
      }
    }
    return null;
  }

  /**
   * 按 id 问一次"调用者能不能读写这张画布"。
   *
   * 进画布时读它，决定是只读提示还是正常编辑。**优先用来源的 `access`**：只有它能把
   * "远端明确拒绝"和"这次没答案"分开；来源没有这个能力时退回摘要里的 access（列表里
   * 已知的权限），两者都没有就返回 null（未知，按可写处理，与旧行为一致）。
   *
   * 失败不抛错：权限读取是展示前置，不是打开画布的前提。
   */
  async accessOf(canvasId: string): Promise<import("@woohaa3/contracts").CanvasAccess | null> {
    for (const source of this.remoteSources()) {
      if (typeof source.access === "function") {
        try {
          const access = await source.access(canvasId);
          if (access !== null) return access;
        } catch {
          // 来源故障 = 这次没答案，继续问下一个来源。
        }
      }
      try {
        const found = (await source.list()).find((item) => item.id === canvasId);
        if (found?.access !== undefined) return found.access;
      } catch {
        // 与合并路径同一口径：来源故障不变成"这张画布不存在"。
      }
    }
    // 来源没答案（含远端对不可见画布统一回 not_found——它刻意不区分"不存在"与"没权限"）。
    // 只有**这张画布属于远端**时才能把"查不到"解释成"当前账号没有访问权限"：
    // 纯本地画布本来就不该出现在远端，查不到是正常的，不能因此判只读。
    if (this.isRemoteOwned?.(canvasId)) return { canRead: false, canWrite: false };
    return null;
  }

  /** 给单个摘要补上同步状态（纯本地路径也要标，界面才知道它同步没同步）。 */
  private withSync(summary: CanvasSummary): CanvasSummary {
    const sync = this.syncStateOf?.(summary.id);
    return sync === undefined ? summary : { ...summary, sync };
  }

  private async mergeSummary(structured: CanvasSummary): Promise<CanvasSummary> {
    const projection = await this.published.loadPublished(structured.id);
    if (projection === null) return structured;
    assertUsableProjection(structured.id, projection);
    return {
      // id / createdAt 始终来自结构化目录。
      id: structured.id,
      createdAt: structured.createdAt,
      // 已 bootstrap：标题、revision、更新时间与计数一律取自 published projection。
      title: typeof projection.title === "string" ? projection.title : "",
      revision: projection.revision,
      updatedAt: projection.updatedAt,
      nodeCount: projection.document.nodes.length,
      assetCount: projection.assets.length
    };
  }
}

/**
 * projection 形态校验：已有 document 的 projection 必须自洽，否则视为损坏。
 * 只校验目录消费所需字段，避免逐个节点深度校验（那是 room 的职责）。
 */
function assertUsableProjection(canvasId: string, projection: ServerCanvas): void {
  const valid =
    projection !== null &&
    typeof projection === "object" &&
    projection.id === canvasId &&
    typeof projection.revision === "number" &&
    Number.isInteger(projection.revision) &&
    projection.revision >= 0 &&
    typeof projection.updatedAt === "string" &&
    projection.document !== null &&
    typeof projection.document === "object" &&
    Array.isArray(projection.document.nodes) &&
    Array.isArray(projection.assets);
  if (!valid) {
    throw new CanvasStorageError("REPOSITORY_FAILURE", `画布 ${canvasId} 的 published projection 不可用`);
  }
}
