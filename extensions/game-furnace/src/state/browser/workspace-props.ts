import type { ApplicationRemoteService, CanvasCommandsService, CanvasStoreFacade, MediaRemoteService, TaskCatalogService } from "@woohaa3/frontend/extension-api";

export type GameFurnaceWorkspaceProps = {
  writable: boolean;
  nodeId: string | null;
  canvasState: CanvasStoreFacade;
  commands: CanvasCommandsService;
  remote: ApplicationRemoteService;
  mediaRemote: MediaRemoteService;
  taskCatalog: TaskCatalogService;
  onConfigureModels: () => void;
  onBack: () => void;
  /**
   * 宿主派生的通用模态门禁（change: 2026-10-10-add-game-furnace-extension，任务 5.9/8.7）：
   * 模态 Dialog 打开时暂停/停止试玩并释放 capture；关闭**不**自动恢复（不自动试玩）。
   */
  modalActive?: boolean;
};

