/**
 * 复合内容扩展的**聚合运行时**端口
 * （change: 2026-10-17-decouple-film-set-from-canvas-service）。
 *
 * 宿主（canvas-service）只依赖这里的接口；具体内容领域（片场）由扩展实现并通过
 * `extension.json` 的 `canvasContent` 声明装配。端口按能力分组、全部可选：
 * - `frames`：预览帧 / 历史缩略图帧 / 渲染身份（见 `content-frame.ts`）；
 * - `conversion`：单节点「转为片场」的转换服务构造（见 `content-conversion.ts`）；
 * - `recording`：独立原生录制的冻结/提交端口（见 `content-recording.ts`）。
 *
 * 未提供某组能力时，对应功能在宿主侧**明确不可用**（返回稳定错误码 / 跳过装配），
 * 不会静默退化或由宿主私自实现。
 */
import type { ContentFrameRuntime } from "./content-frame.js";
import type { ContentConversionRuntime } from "./content-conversion.js";
import type { ContentMcpRuntime } from "./film-set-mcp.js";
import type { ContentRecordingRuntime } from "./content-recording.js";

export type CanvasContentRuntime = {
  /** 预览/历史帧端口。 */
  frames?: ContentFrameRuntime;
  /** 转片场能力端口。 */
  conversion?: ContentConversionRuntime;
  /** MCP 能力面（片场节点/导入/对象变更）。 */
  mcp?: ContentMcpRuntime;
  /**
   * 独立原生录制端口（change: 2026-10-17-add-native-offscreen-film-set-recording）。
   *
   * 未装配时宿主把录制能力明确报告为 `recording-unavailable`；不会静默回落到浏览器路径。
   */
  recording?: ContentRecordingRuntime;
};
