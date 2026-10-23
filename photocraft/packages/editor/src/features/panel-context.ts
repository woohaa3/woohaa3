import type { EditorWorkspaceController } from "../editor-workspace.js";
import type { EditorViewModel } from "../editor-view-model.js";

/** Read-only UI projection and explicit effects; no second document or history store. */
export interface FeaturePanelContext {
  controller: EditorWorkspaceController;
  panelRequest?: { panel: string; command: string; sequence: number };
  /**
   * 当前文档不可写：没有文档、只读、导出中、有模态等**全部**原因合并后的结果。
   *
   * 适合「操作当前文档」的面板：没有文档时它们本来也无事可做。
   */
  locked: boolean;
  /**
   * 真正不可写：只读、关闭中、忙碌、视图过渡、导出中或有模态。
   *
   * 与 [`locked`] 的唯一区别是**不包含「没有文档」**。新建文档恰好只在没有文档时成立，
   * 用 `locked` 会把它唯一可用的状态禁掉，所以需要新建的入口必须看这个字段。
   */
  readonly: boolean;
  /**
   * 申请独立文档槽位：把新建好的文档字节交给宿主办成新标签（宿主提供时才有）。
   *
   * 一个编辑会话只有一个文档槽位，因此「已有文档时再新建」必须由宿主另开文档；
   * 没有本端口时新建入口按「当前会话为空才能建」如实禁用。
   */
  requestDocumentSlot?: (bytes: Uint8Array, name: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * 最近文件索引（U04，change: 2026-10-22-add-photocraft-file-workflows）。
   *
   * 字节由宿主持有，本域只拿「身份 + 大小」。区分三种状态：
   * - `undefined`：宿主没有该端口（不渲染本区，也不伪造空列表）；
   * - `null`：宿主明确表示不可用（渲染原因）；
   * - 索引对象：渲染真实记录；空 `entries` 才表示「确实还没打开过文件」。
   */
  recentFiles?: import("@woohaa3/photocraft-protocol").RecentFileStore | null;
  /**
   * 最近文件索引的本机持久化诊断（写失败/快照损坏）。
   *
   * 记录可以跨会话保留而字节不能；**持久化失败**同样必须让用户看到，否则列表看起来正常、
   * 刷新后却全部消失。
   */
  recentFilesError?: string | null;
  /** 重开一条最近文件（宿主用自己的字节引用真正打开）；缺省时入口显示「需重新选择」。 */
  reopenRecent?: (entry: import("@woohaa3/photocraft-protocol").RecentFileEntry) =>
    Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 从最近记录移除一条。 */
  removeRecent?: (id: string) => void;
  /** 逐条回答「这条记录现在还有字节可重开吗」（刷新后记录仍在、字节已不在）。 */
  hasRecentBytes?: (entry: import("@woohaa3/photocraft-protocol").RecentFileEntry) => boolean;
  /**
   * 把一条导出预设交给栅格交换域（U04）。
   *
   * 导出参数预设的实现与存储由 `features/io/` 唯一持有；本域只转交用户选择，
   * 不读取、不解释、也不缓存导出设置。
   */
  applyExportPreset?: (preset: { name: string; settings: unknown }) => void;
  /** 当前文档是否有未结算草稿或正在保存（最近文件重开/新建前必须结算）。 */
  documentBusy?: boolean;
  documentView: EditorViewModel["document"];
  activeLayer: NonNullable<EditorViewModel["document"]>["layers"][number] | undefined;
  activeLayerId: number | null;
  colors: { foreground: string; background?: string };
  /**
   * 可写颜色端口（change: 2026-10-22-add-photocraft-painting-color-workflows，任务 3.4）。
   *
   * 为什么必须由宿主提供而不是面板自己 setState：前景/背景色属于**共享外壳状态**
   * （工具轨色板、`paint.stroke` 的默认 color、`foreground`/`background` 渐变色标都读它）。
   * 面板私有一份副本会让吸管取到的色只改自己、不改实际落笔颜色。提供时面板才渲染
   * 「写入前景/背景色」按钮；未提供时如实降级为只读报告，不留假控件。
   */
  setColor?: (color: string, target?: "foreground" | "background") => void;
  brush: { color: string };
  refreshPreview(): void;
  updateAids(): void;
  retouchTool: string;
  retouchSample: [number, number] | null;
  retouchAligned: boolean;
  setRetouchAligned(value: boolean): void;
  /**
   * 切到某个修饰命令并启用修饰手势（「滤镜 → 修饰工具…」面板里的工具选择）。
   *
   * 与上下文栏下拉共用同一个 `retouchTool`：面板不能再存一份，否则面板里选的命令和画布
   * 实际走的手势会各说各话。旧装配没提供时面板不渲染选择器（只显示当前命令的参数）。
   */
  activateRetouchTool?(id: string): void;
  /** 进入「下一次画布单击即取样」状态（面板的「设置采样点」按钮）。 */
  armRetouchSample?(): void;
  setMessage(value: string): void;
  /**
   * 应用命名工作区的面板几何（可选）。
   *
   * 外壳提供时当次立即重排；缺省由面板退回写布局键并如实提示「重新打开编辑器后生效」。
   */
  applyPanelLayout?(layout: Record<string, unknown>): void;
}
