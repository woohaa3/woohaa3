import type { Context, CanvasStoreFacade, CanvasSession, CanvasRuntimeService, CanvasEditService, SlotsService, CanvasNavigationService, MediaRemoteService, CompositeAssetRegistry, ModelWorkspaceService, HoverStateService, CanvasRemoteService, CanvasScopeService, CanvasLocateService, DialogsService } from "@woohaa3/frontend/extension-api";
import type { FilmSetPlaybackService } from "./playback-service.js";
export type FilmSetContext = Context & {
  canvasState: CanvasStoreFacade; canvasSession: CanvasSession; canvasRuntime: CanvasRuntimeService;
  canvasEdit: CanvasEditService; slots: SlotsService; canvasNavigation: CanvasNavigationService;
  mediaRemote: MediaRemoteService; compositeAssets: CompositeAssetRegistry;
  modelWorkspace: ModelWorkspaceService; hoverState: HoverStateService;
  canvasScope: CanvasScopeService; canvasRemote: CanvasRemoteService; canvasLocate: CanvasLocateService;
  dialogs: DialogsService;
  agentConversationService: Context["agentConversationService"];
  currentUser: Context["currentUser"];
  filmSetPlayback: FilmSetPlaybackService;
};
