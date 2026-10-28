/**
 * 把宿主的画布目录接成四喜的「项目」数据源。
 *
 * 四喜原本自己有一套项目（`GET /projects`，桌面端是 mock 内存数组）。扩展形态下那套数据
 * 与宿主里真实存在的画布毫无关系 —— 表现为项目页永远显示「示例项目 A/B」。
 * 这里把两边接起来：**一个项目 = 一张画布**。
 *
 * 字段映射与各自的缺口：
 * ```
 * Project.id        ← CanvasSummary.id
 * Project.name      ← CanvasSummary.title（空标题由四喜卡片兜底显示）
 * Project.createdAt ← CanvasSummary.createdAt
 * Project.updatedAt ← CanvasSummary.updatedAt
 * Project.status    ← 恒为 'active'
 * ```
 *
 * **`status` 为什么恒为 active**：宿主没有归档概念（只有 `sync` / `access`）。四喜的
 * 「已归档」是它自己的状态，与画布的存续无关；归档导出走的是画布切换器里的那个按钮，
 * 不做成 `status`，否则两套「归档」会打架（一个在四喜列表里隐藏，一个在宿主里真的搬走）。
 *
 * 能力边界（宿主接口决定的，不是这里省掉的）：
 * - **新建**可以（`canvasCatalog.create`），但只能给标题，不能预置内容；
 * - **重命名**只能改**当前打开的那张**（Yjs 命令通道绑定在当前会话上），
 *   宿主目录没有 `rename` 方法。列表里改别人的名字做不到，这里如实失败并说明原因；
 * - **删除**宿主前端没有通路（后端有 DELETE，但目录接口没暴露），这里不做。
 */
import type { CanvasCatalogService, CanvasSummary } from "@woohaa3/frontend/extension-api";
import type { ProjectSort } from "@/api/contract";
import type { Project, ProjectListResult, ProjectPatch } from "@/api/contract";
import type { NormalizedProjectListQuery } from "@/api/contract";
import type { ProjectSource } from "@/api/projectSource";

/** 宿主分页上限（`MAX_CANVAS_CATALOG_PAGE_SIZE`）。一次取满，四喜侧再本地分页。 */
const HOST_PAGE_SIZE = 100;

/**
 * 画布的辅助信息拼进 `description`。
 *
 * 四喜的卡片不显示 description，但**项目详情页显示**——「7 个节点 · 3 个素材」放那里
 * 正合适，而 `Project` 没有更贴切的字段。
 */
function describe(entry: CanvasSummary): string {
  const parts: string[] = [];
  if (entry.nodeCount > 0) parts.push(`${entry.nodeCount} 个节点`);
  if (entry.assetCount > 0) parts.push(`${entry.assetCount} 个素材`);
  return parts.join(" · ");
}

function toProject(entry: CanvasSummary): Project {
  return {
    id: entry.id,
    name: entry.title.trim() || "未命名画布",
    ...(describe(entry) ? { description: describe(entry) } : {}),
    // 宿主没有归档概念：能出现在目录里的画布都是「进行中」。
    status: "active",
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  };
}

/** 与四喜 `ProjectSort` 同义；`recent` 按更新、`created` 按创建、`name` 按标题。 */
function sortProjects(items: Project[], sort: ProjectSort): Project[] {
  const copy = [...items];
  if (sort === "name") return copy.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const key = sort === "created" ? "createdAt" : "updatedAt";
  return copy.sort((a, b) => (a[key] < b[key] ? 1 : a[key] > b[key] ? -1 : 0));
}

function matches(project: Project, keyword: string): boolean {
  if (keyword === "") return true;
  const needle = keyword.toLowerCase();
  return (
    project.name.toLowerCase().includes(needle) ||
    (project.description ?? "").toLowerCase().includes(needle)
  );
}

/**
 * 建一个四喜可用的数据源。
 *
 * `catalog` 是宿主的 App scope 目录服务；它自带缓存，`load()` 命中缓存会直接返回，
 * 所以列表前显式 `load(true)` —— 用户刚在宿主里建了画布，切回四喜就该看到。
 */
export function createHostProjectSource(catalog: CanvasCatalogService): ProjectSource {
  /** 取全部画布并转成项目。目录分页上限 100，超过时分批取。 */
  const allProjects = async (): Promise<Project[]> => {
    const first = await catalog.load(true);
    if (!first.ok) throw new Error(first.error);
    let total = first.total;
    // 画布多于一批：继续追加，直到取满（或取不动了，避免死循环）。
    while (catalog.getState().entries.length < total) {
      const before = catalog.getState().entries.length;
      await catalog.loadMore();
      const after = catalog.getState().entries.length;
      if (after <= before) break;
      total = Math.max(total, catalog.getState().total);
    }
    return catalog.getState().entries.map(toProject);
  };

  return {
    async list(query: NormalizedProjectListQuery): Promise<ProjectListResult> {
      const projects = await allProjects();
      // 状态筛选：宿主侧一律 active，所以 'archived' 永远是空，'all' 全量。
      const byStatus =
        query.status === "archived" ? [] : query.status === "active" ? projects : projects;
      const filtered = sortProjects(
        byStatus.filter((project) => matches(project, query.q)),
        query.sort
      );
      const start = (query.page - 1) * query.pageSize;
      return {
        items: filtered.slice(start, start + query.pageSize),
        total: filtered.length,
        page: query.page,
        pageSize: query.pageSize
      };
    },

    async get(id: string): Promise<Project> {
      // 先用目录缓存；没有再单独查一次（进入详情页时可能还没加载过列表）。
      const cached = catalog.getState().entries.find((entry) => entry.id === id);
      if (cached) return toProject(cached);
      const result = await catalog.get(id);
      if (!result.ok) throw new Error(result.error);
      return toProject({
        ...result.summary,
        // `CanvasDetailSummary` 没有 `createdAt`；详情页需要它，用更新时间顶替。
        createdAt: result.summary.updatedAt
      });
    },

    async create(input: { name: string; description?: string }): Promise<Project> {
      const result = await catalog.create({ title: input.name });
      if (!result.ok) throw new Error(result.error);
      const now = new Date().toISOString();
      return {
        id: result.canvasId,
        name: result.title.trim() || input.name,
        status: "active",
        createdAt: now,
        updatedAt: now
      };
    },

    async update(id: string, patch: ProjectPatch): Promise<Project> {
      /*
       * 重命名只能改**当前打开的那张**画布 —— 宿主的 `canvas.setTitle` 走当前 Yjs 会话，
       * 目录接口没有跨画布的 rename。这里如实拒绝，不去动别的画布。
       */
      if (patch.name !== undefined) {
        const current = catalog.getState().entries.find((entry) => entry.id === id);
        if (!current) throw new Error("画布不存在");
        throw new Error(
          "扩展形态下只能重命名正在打开的画布：请先在宿主里打开它，再用画布切换器改名"
        );
      }
      // description / status 在宿主侧没有对应字段，静默忽略，把当前值返回。
      return this.get(id);
    }
  };
}
