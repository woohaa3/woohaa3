/**
 * 片场内容扩展的聚合运行时（`CanvasContentRuntime` 实现）
 * （change: 2026-10-17-decouple-film-set-from-canvas-service）。
 *
 * 宿主 canvas-service 只依赖 `@woohaa3/contracts` 的端口；片场领域实现（预览帧、转片场服务、
 * 媒体读取、内存登记仓）全部留在这里，由扩展声明装配。
 */
import type { CanvasContentRuntime, ContentConversionRuntime } from "@woohaa3/contracts";
import { createFilmSetConversionMediaReader } from "../../authoring/backend/conversion-media.js";
import { InMemoryFilmSetConversionRegistry } from "../../authoring/backend/conversion-registry.js";
import { FilmSetConversionService } from "../../authoring/backend/film-set-conversion.js";
import { filmSetFrameRuntime } from "./frame-runtime.js";
import { filmSetMcpRuntime } from "./mcp-runtime.js";
import { createFilmSetRecordingRuntime } from "./recording-runtime.js";
import { filmSetManagedLifecycle } from "../../state/shared/managed-shot-media-lifecycle.js";
import { filmSetManagedMediaMigration } from "../../state/shared/managed-shot-media-migration.js";
import { filmSetContentContribution } from "../../state/shared/content/contribution.js";
import { filmSetInteractionPolicy } from "../../state/shared/content/interaction.js";
import { filmSetOwnerLocators } from "../../state/shared/content/locators.js";

const conversionRuntime: ContentConversionRuntime = {
  createService: (deps) => new FilmSetConversionService(deps),
  createMediaReader: ({ read }) => createFilmSetConversionMediaReader({ read }),
  createInMemoryRegistry: () => new InMemoryFilmSetConversionRegistry()
};

/**
 * 原生录制端口（change: 2026-10-17-add-native-offscreen-film-set-recording）。
 *
 * 只有具备本机执行器的部署才会真正用上它；端口存在本身不改变浏览器路径，宿主按能力选择。
 */
const recordingRuntime = createFilmSetRecordingRuntime();

export const filmSetCanvasContentRuntime: CanvasContentRuntime = {
  content: [{ ...filmSetContentContribution, interaction: filmSetInteractionPolicy, ownerLocators: filmSetOwnerLocators }],
  managedLifecycles: [filmSetManagedLifecycle],
  managedMigrations: [filmSetManagedMediaMigration],
  frames: filmSetFrameRuntime,
  conversion: conversionRuntime,
  mcp: filmSetMcpRuntime,
  recording: recordingRuntime
};

/**
 * `extension.json` 的 `canvasContent.factory`：返回聚合运行时。
 *
 * 工厂无副作用，返回同一个不可变端口对象。
 */
export function createFilmSetCanvasContentRuntime(): CanvasContentRuntime {
  return filmSetCanvasContentRuntime;
}
