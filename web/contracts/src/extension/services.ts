import type { MediaMetadata } from '../media/protocol.js';
import type { TaskErrorSummary, TaskResultSummary } from '../task/history.js';

export type ApplicationExtensionTaskResult = {
  workerTaskKey: string;
  state: string;
  result?: TaskResultSummary;
  /** 已由 Task 历史白名单裁剪的失败摘要，供扩展给出可操作的错误。 */
  error?: TaskErrorSummary;
};

export type ApplicationExtensionMediaResourcesFacade = {
  /**
   * 读取稳定资源字节。
   *
   * `canvasId` 可选，但**能确定所属画布时必须传**：远端画布的媒体字节只存在服务端托管存储
   * （键布局 `<canvasId>/media/<key>`），本地主存储里没有；省略作用域会按 `media/<key>` 去
   * 读主存储，把一张存在的远端素材报成 404。省略表示「与画布无关」（扩展素材、独立页），
   * 保持历史行为。
   */
  read(storageKey:string,canvasId?:string):Promise<{bytes:Uint8Array;contentType:string}>;
  /**
   * 写入内容寻址的稳定资源。
   *
   * `canvasId` 语义同 `read`：属于远端画布时必须带，否则字节只落本机主存储，其他协作者
   * 与换机后的自己都读不到；省略表示与画布无关。
   */
  write(input:{bytes:Uint8Array;contentType:string;canvasId?:string}):Promise<MediaMetadata>;
  openRead?(storageKey:string,canvasId?:string):Promise<{bytes:AsyncIterable<Uint8Array>;contentType:string;size:number;cancel():void}>;
  writeStream?(input:{bytes:AsyncIterable<Uint8Array>;contentType:string;maxBytes?:number;signal?:AbortSignal;canvasId?:string}):Promise<MediaMetadata>;
};

/**
 * 完整媒体核验结果（change: 2026-10-12-add-extension-online-canvas-migration，任务 2.5）。
 *
 * 与 `stat` 的区别：`stat` 只回存在性与 contentType 的粗粒度探测；`verify` 回**完整**
 * 稳定 metadata（含真实 size 与 checksum），供来源迁移在目标同存储复用时核验，不得凭 key
 * 推断 size 或填 0。
 */
export type ApplicationExtensionMediaVerifyResult =
  | { exists: false }
  | { exists: true; metadata: MediaMetadata };
