import { screenToDocument, type CanvasViewport, type DocumentPoint } from "./shared/tool-parameters.js";

/** One unrotated document/client mapping, shared by gestures and future view contributions. */
export interface DocumentCoordinatePort {
  documentToView(point: DocumentPoint, viewport: CanvasViewport): DocumentPoint | null;
  viewToDocument(clientX: number, clientY: number, viewport: CanvasViewport, constrain?: boolean): DocumentPoint | null;
}

export const DOCUMENT_COORDINATES: DocumentCoordinatePort = {
  viewToDocument: screenToDocument,
  documentToView(point, viewport) {
    if (!screenToDocument(viewport.left, viewport.top, viewport, false) || ![point.x, point.y].every(Number.isFinite)) return null;
    return {
      x: viewport.left + point.x * viewport.width / viewport.documentWidth,
      y: viewport.top + point.y * viewport.height / viewport.documentHeight
    };
  }
};
