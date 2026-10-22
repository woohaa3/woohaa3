import type { RefObject } from "react";
import type { ServerCanvas } from "@woohaa3/contracts";
import type { GameFurnaceRemote } from "./remote-port.js";

export type GameFurnacePreviewController = {
  buildId: string | null;
  html: string | null;
  url: string | null;
  loaded: boolean;
  error: string | null;
  bridge: { nonce: string; generation: number } | null;
  panelRef: RefObject<HTMLElement>;
  frameRef: RefObject<HTMLIFrameElement>;
  frameKey: number;
  play: (buildId: string) => Promise<void>;
  stop: () => void;
  /** 仅用于受校验消息到达时标记就绪。 */
  markLoaded: () => void;
};

export type WorkspacePreviewOptions = {
  client: Pick<GameFurnaceRemote, "previewOpen" | "previewDescribe" | "previewClose">;
  canvas: () => ServerCanvas | null;
  nodeId: string | null;
  /** 当前画布 id（用于切换时释放旧会话）。 */
  canvasId: string | undefined;
  captureValidity: () => (() => boolean);
  stillCurrent: (canvasId: string, nodeId: string, write?: boolean) => boolean;
};
