import type { CanvasNodeData } from "../canvas/domain/types.js";
import type { MediaObject } from "../media/storage.js";

/** 可信扩展的离线归档贡献；不启动插件、不执行任务、不写 Canvas/Media。 */
export type ApplicationExtensionArchiveDefinition = {
  extensionId: string;
  /** 列出节点所需的全部稳定媒体键，包括项目、历史构建及其不可变依赖。 */
  collectMediaKeys(input: {
    nodeData: CanvasNodeData;
    /** 宿主只允许读取受控内容寻址键；没有任意 URL 或存储写权限。 */
    read: (storageKey: string) => Promise<MediaObject>;
  }): Promise<readonly string[]>;
};
