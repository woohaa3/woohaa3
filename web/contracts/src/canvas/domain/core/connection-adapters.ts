import type { Woohaa3CanvasJsonObject } from "./document-schema";
import type { Woohaa3CanvasConnection, Woohaa3CanvasNode } from "./canvas-runtime";

/**
 * A plugin-owned interpretation of a graph connection. Core only supplies
 * structural graph data; plugins decide whether their target node handles it.
 */
export type Woohaa3CanvasConnectionAdapterContext = {
  connection: Woohaa3CanvasConnection;
  sourceNode: Woohaa3CanvasNode;
  targetNode: Woohaa3CanvasNode;
  sourceData: Woohaa3CanvasJsonObject | undefined;
  targetData: Woohaa3CanvasJsonObject | undefined;
};

export type Woohaa3CanvasConnectionAdapterResult = {
  edgeData?: Woohaa3CanvasJsonObject;
  targetDataPatch?: Woohaa3CanvasJsonObject;
};

export type Woohaa3CanvasConnectionAdapter = (
  context: Woohaa3CanvasConnectionAdapterContext
) => Woohaa3CanvasConnectionAdapterResult | null;
