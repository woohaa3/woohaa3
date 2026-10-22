import type { Context, SlotsService, CompositeAssetRegistry, CanvasStoreFacade, CanvasRuntimeService, CanvasCommandsService, ApplicationRemoteService, TaskCatalogService, CanvasNavigationService, MediaRemoteService, SelectionService } from "@woohaa3/frontend/extension-api";
export type WorkflowContext = Context & {
  slots: SlotsService; compositeAssets: CompositeAssetRegistry; canvasState: CanvasStoreFacade;
  canvasRuntime: CanvasRuntimeService; canvasCommands: CanvasCommandsService;
  applicationRemote: ApplicationRemoteService; taskCatalog: TaskCatalogService;
  canvasNavigation: CanvasNavigationService; mediaRemote: MediaRemoteService; selection: SelectionService;
};
