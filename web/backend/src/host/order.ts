/** 同源处理器的匹配顺序：运行期扩展发布资源最先（未命中即交下游），站点插件公开路由其次，领域服务的宽前缀在后。 */
export const ROUTE_ORDER = {
  releaseCatalog: 0,
  /**
   * `/api/extensions/install|restart|marketplace|<id>/uninstall|<id>/rollback`：扩展安装（change: 2026-10-21-add-extension-marketplace-point）。
   * 必须排在 application（10）的 `/api/extensions/*` 宽前缀之前；只认这几条路径，其余交下游。
   */
  extensionInstall: 5,
  /**
   * 受管扩展子进程的 gateway 转发（change: 2026-10-21-isolate-extension-host-process，D6）：只认子进程登记的
   * 前缀与宿主授予的保底前缀（`/api/extensions/<id>/`、modelRefresh 路径），其余交下游；必须排在
   * application（10）的 `/api/extensions/*` 宽前缀之前，否则会被它以「未知的插件路由」截走。
   */
  extensionHostForward: 7,
  application: 10,
  /** `/api/application/session`：身份/权限读模型，前端 `current-user.ts` 每次启动都请求。 */
  session: 15,
  generationModels: 20,
  /** `/api/providers`：Provider 凭据状态与写入；排在 Provider 自己的 `/api/providers/<id>/refresh`（25）之后。 */
  providers: 30,
  settings: 40,
  /** `/api/host/restart`：受控重启（change: 2026-10-21-harden-extension-fault-isolation，D6）。 */
  hostRestart: 41,
  /**
   * `/api/telemetry/*`：本机遥测的 intake 与复盘查询（change: 2026-10-20-add-local-client-telemetry）。
   * 路径不落进 canvas / task / mcp / media 的宽前缀；同源 ingress 的对应登记在
   * `scripts/lib/ingress.mjs` 的 `routeFor`（未登记会被判 `none` 直接 404）。
   */
  telemetry: 42,
  mcpInstallation: 45,
  canvas: 60,
  taskInspection: 65,
  task: 70,
  mcp: 80,
  media: 90
} as const;

/** 就绪检查的顺序：第一个未就绪的原因会被报告。 */
export const READINESS_ORDER = {
  storage: 1,
  canvas: 2,
  task: 3,
  media: 4,
  mcp: 5
} as const;

/**
 * 录制执行器不参与启动就绪：桌面端没有 supervisor 时宿主仍可正常启动，录制能力按次查询
 * 返回 `recording-executor-unavailable`（design D9：缺执行器给可恢复原因，不永久等待）。
 *
 * 遥测同样不参与启动就绪（change: 2026-10-20-add-local-client-telemetry，design D7/D11）：
 * 本地库打不开不能拖垮业务，能力改为在 `ctx.telemetry.status()` 的 `localStore = "unavailable"`
 * 与复盘页里说明原因，也不自动删除或重建用户数据。
 */
