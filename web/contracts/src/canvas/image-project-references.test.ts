import { expect, it } from "vitest";
import { IMAGE_PROJECT_CONTENT_TYPE } from "./image-edit.js";
import { decodeImageProjectReferencesRequest } from "./image-project-references.js";

const input = { canvasId: "target", sourceCanvasId: "source", nodeIds: ["node"], assetIds: ["asset"],
  projects: [{ storageKey: `sha256-${"a".repeat(64)}`, checksum: "a".repeat(64), contentType: IMAGE_PROJECT_CONTENT_TYPE, size: 20 }] };
it("跨画布核验只接受有界引用与受控工程对象", () => {
  expect(decodeImageProjectReferencesRequest(input)).toEqual(input);
  expect(decodeImageProjectReferencesRequest({ ...input, nodeIds: Array(257).fill("node") })).toBeNull();
  expect(decodeImageProjectReferencesRequest({ ...input, sourceCanvasId: "" })).toBeNull();
  expect(decodeImageProjectReferencesRequest({ ...input, projects: [{ ...input.projects[0], storageKey: "https://outside/file" }] })).toBeNull();
  expect(decodeImageProjectReferencesRequest({ ...input, projects: [{ ...input.projects[0], contentType: "image/png" }] })).toBeNull();
});
