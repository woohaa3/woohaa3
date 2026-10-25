/**
 * 拍摄镜头预览卡片与归属线 wire 类型
 * （自 `wire-scene.ts` 拆出；change: 2026-10-15-add-film-set-shooting-shot-previews，design D2/D5/D7/D8）。
 *
 * 只承载发给 Bevy `set_scene` 的**派生呈现**结构：卡片状态/标题/类型/画幅/时长/状态、零点
 * 封面相机与归属线端点。它们都是所属源镜头的只读投影，不写回 ServerCanvas / Y.Doc。
 */

/**
 * 拍摄镜头预览卡片状态
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，design D8）。
 *
 * - `preparing`：首次准备/纹理回收后重新准备，展示可辨识占位；
 * - `ready`：封面或活动画面已就绪；
 * - `stale`：源内容变化但尚未重新采样，旧图被明确标识为「待更新」；
 * - `error`：源脚本或媒体失败，保留归属并展示可理解诊断。
 */
export type BevyShotPreviewCardState = "preparing" | "ready" | "stale" | "error";

/**
 * 拍摄镜头预览卡片呈现
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，design D2/D8）。
 *
 * 卡片完整保留镜头 `aspect`；标题为镜头名并附静态/动态类型；动态显示时长与本地播放进度，
 * 静态无播放控件。所有字段都由源镜头投影派生，**不写回** ServerCanvas / Y.Doc。
 */
export type BevyShotPreviewPresentation = {
  /** Hide the canvas presentation while keeping this target available for offscreen capture. */
  hidden?: boolean;
  /** 所属片场 canonical 节点 id（归属校验与双击导航）。 */
  filmSetNodeId: string;
  /** 所属镜头稳定 clipId。 */
  clipId: string;
  /** 静态/动态类型（由源镜头 kind 投影）。 */
  kind: "static" | "dynamic";
  /** 镜头名（卡片主标题）。 */
  name: string;
  /** 画幅（宽/高数值）；内容完整保留该比例，不拉伸或裁切。 */
  aspect: number;
  /** 时间线时长（秒）；静态镜头为 0。 */
  duration: number;
  /** Explicit custom shot background; absent uses the current theme. */
  backdrop?: string;
  /**
   * 零点封面相机（静态与非活动动态镜头使用）
   * （change: 2026-10-15-add-film-set-shooting-shot-previews，design D7）。
   *
   * 静态卡片与非活动动态卡片只在 T=0 取零点画面；GPU 侧据此在世界包围球上派生相机姿态，
   * 不需要逐帧动作 IR、也不传像素。活动动态卡片改用 `animationPlayback` 同一 T 的采样相机。
   */
  coverCamera: {
    azimuth: number;
    elevation: number;
    distance: number;
    focusOffset: [number, number, number];
  };
  /** 当前就绪/待更新/失败状态。 */
  state: BevyShotPreviewCardState;
  /** 本地播放进度 0..1；仅动态活动预览携带（不参与 canonical）。 */
  progress?: number;
  /** 是否正在本地播放（仅动态）。 */
  playing?: boolean;
  /** 可理解诊断（`state` 为 `stale`/`error` 时的原因摘要）。 */
  diagnostic?: string;
};

/**
 * 拍摄镜头归属线（change: 2026-10-15-add-film-set-shooting-shot-previews，design D5）。
 *
 * 从源镜头的小相机标记世界姿态投影出的画布起点，连到预览卡片接口（左侧中点）。这是
 * **派生呈现**：不进入 `document.edges` 或 inputMapping，没有端口、删除按钮、断开或重连。
 * `start` 由映射层按当前观察相机从世界姿态投影得到（活动动态镜头用同一 T 的采样相机）。
 */
export type BevyShotPreviewLink = {
  /** 稳定身份（由 owner + clip 派生，不随位置变化）。 */
  id: string;
  /** 归属源片场 canonical 节点 id。 */
  ownerNodeId: string;
  /** 目标预览卡片 canonical 节点 id。 */
  previewNodeId: string;
  /** 归属镜头稳定 clipId。 */
  clipId: string;
  /** 画布 2D 起点（世界相机姿态经当前观察相机投影；活动镜头用同一 T 的采样相机）。 */
  start: { x: number; y: number };
};
