import { describe, expect, it } from "vitest";
import {
  EMPTY_WORLD_CAPTURE_CONTENT_FINGERPRINT,
  WORLD_CAPTURE_CONTENT_RESOLUTION_VERSION,
  WORLD_CAPTURE_MODEL_CONTENT_VERSION,
  createWorldCaptureInstanceContents,
  createWorldCaptureModelContent,
  decodeWorldCaptureContentResolutionRequest,
  verifyWorldCaptureContentResolution,
  worldCaptureContentFingerprint,
  worldCaptureModelContentHash,
  type WorldCaptureContentResolution,
  type WorldCaptureContentResolutionRequest,
  type WorldCaptureInstanceContent,
  type WorldCaptureModelContent
} from "./world-capture-content-contract.js";
import {
  DEFAULT_MODEL_PLACEMENT,
  deriveModelContentVersion,
  glbModelContentHash,
  glbModelSourceHash,
  type ModelPlacement
} from "./model-definition.js";
import { MODEL_SCRIPT_LANGUAGE, MODEL_SCRIPT_V2_VERSION } from "./model-script.js";
import {
  PREPARED_MODEL_RESOURCE_VERSION,
  prepareModelResource,
  type PreparedModelResource
} from "./prepared-model.js";
import type { SceneV2Op } from "./scene-ir-v2.js";
import type { SharedWorldDecodeResult } from "./shared-world.js";

const SCENE_VERSION = "woohaa-model-scene-ir-v2";

function clonePlacement(placement: ModelPlacement = DEFAULT_MODEL_PLACEMENT): ModelPlacement {
  return { offset: { ...placement.offset }, scale: placement.scale, yaw: placement.yaw };
}

function scriptModel(
  source: string,
  placement: ModelPlacement = clonePlacement()
): WorldCaptureModelContent {
  const contentVersion = deriveModelContentVersion({
    modelScript: source,
    modelScriptLanguage: MODEL_SCRIPT_LANGUAGE,
    modelScriptVersion: MODEL_SCRIPT_V2_VERSION,
    placement,
    revision: 1
  });
  return {
    version: WORLD_CAPTURE_MODEL_CONTENT_VERSION,
    kind: "script",
    definition: {
      modelScript: source,
      modelScriptLanguage: MODEL_SCRIPT_LANGUAGE,
      modelScriptVersion: MODEL_SCRIPT_V2_VERSION,
      contentVersion,
      placement
    }
  };
}

function glbModel(assetId: string, placement: ModelPlacement = clonePlacement()): WorldCaptureModelContent {
  return {
    version: WORLD_CAPTURE_MODEL_CONTENT_VERSION,
    kind: "glb",
    reference: {
      assetId,
      contentVersion: {
        revision: 1,
        sourceHash: glbModelSourceHash(assetId),
        contentHash: glbModelContentHash({ assetId, placement })
      },
      placement
    }
  };
}

function instanceContent(
  instanceId: string,
  content: WorldCaptureModelContent
): WorldCaptureInstanceContent {
  return { instanceId, content };
}

function expectOk<T>(result: SharedWorldDecodeResult<T>): T {
  if (!result.ok) throw new Error(`expected a decoded value, got ${result.code}`);
  return result.value;
}

function expectInvalid(result: SharedWorldDecodeResult<unknown>): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected rejection");
  expect(result.code).toBe("invalid-data");
}

function boxOp(id: string): SceneV2Op {
  return {
    t: "box",
    id,
    parent: null,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    material: null,
    color: "#ffffff",
    size: [1, 1, 1]
  };
}

function prepared(label: string): PreparedModelResource {
  return prepareModelResource({ sceneVersion: SCENE_VERSION, ops: [boxOp(label)] });
}

function resolutionRequest(
  instances: readonly WorldCaptureInstanceContent[]
): WorldCaptureContentResolutionRequest {
  return {
    requestId: "request-content-1",
    contentFingerprint: worldCaptureContentFingerprint(instances),
    instances
  };
}

function ready(
  request: WorldCaptureContentResolutionRequest,
  resources: readonly {
    instanceId: string;
    contentHash: string;
    resource: PreparedModelResource;
  }[]
): WorldCaptureContentResolution {
  return {
    version: WORLD_CAPTURE_CONTENT_RESOLUTION_VERSION,
    status: "ready",
    requestId: request.requestId,
    contentFingerprint: request.contentFingerprint,
    resources
  };
}

describe("world capture model content", () => {
  it("decodes a script definition and recomputes source/content hashes from the script", () => {
    const content = scriptModel("const root = box();");
    const decoded = expectOk(createWorldCaptureModelContent(content));
    expect(decoded).toEqual(content);
    expect(decoded).not.toBe(content);
    if (decoded.kind !== "script") throw new Error("expected script content");
    expect(decoded.definition.contentVersion.sourceHash).not.toBe("");
    expect(decoded.definition.contentVersion.contentHash).not.toBe("");
    if (content.kind !== "script") throw new Error("expected script content");

    expectInvalid(
      createWorldCaptureModelContent({
        ...content,
        definition: {
          ...content.definition,
          contentVersion: { ...content.definition.contentVersion, sourceHash: "self-reported" }
        }
      })
    );
    expectInvalid(
      createWorldCaptureModelContent({
        ...content,
        definition: {
          ...content.definition,
          contentVersion: { ...content.definition.contentVersion, contentHash: "self-reported" }
        }
      })
    );
  });

  it("pins local placement inside script content identity instead of ignoring it", () => {
    const first = scriptModel("const root = box();", clonePlacement());
    const moved = scriptModel("const root = box();", {
      offset: { x: 1, y: 0, z: 0 },
      scale: 1,
      yaw: 0
    });
    expect(worldCaptureModelContentHash(first)).not.toBe(worldCaptureModelContentHash(moved));

    // The pinned placement survives decode; a stale content hash for the old placement fails.
    if (first.kind !== "script" || moved.kind !== "script") throw new Error("expected script content");
    expectInvalid(
      createWorldCaptureModelContent({
        ...moved,
        definition: {
          ...moved.definition,
          contentVersion: first.definition.contentVersion
        }
      })
    );
  });

  it("decodes a GLB reference and rejects a self-reported asset identity", () => {
    const content = glbModel("asset-old");
    const decoded = expectOk(createWorldCaptureModelContent(content));
    expect(decoded).toEqual(content);
    if (content.kind !== "glb") throw new Error("expected GLB content");

    expectInvalid(
      createWorldCaptureModelContent({
        ...content,
        reference: {
          ...content.reference,
          contentVersion: { ...content.reference.contentVersion, sourceHash: "asset-other" }
        }
      })
    );
    expectInvalid(
      createWorldCaptureModelContent({
        ...content,
        reference: {
          ...content.reference,
          contentVersion: { ...content.reference.contentVersion, contentHash: "asset-other" }
        }
      })
    );
  });

  it("rejects unknown content versions, extra fields and non-exact envelopes", () => {
    const content = scriptModel("const root = box();");
    expect(
      createWorldCaptureModelContent({ ...content, version: "world-capture-model-content-v0" })
    ).toMatchObject({ ok: false, code: "unsupported-version" });
    expectInvalid(createWorldCaptureModelContent({ ...content, mediaUrl: "https://example.invalid/model.glb" }));
    if (content.kind !== "script") throw new Error("expected script content");
    expectInvalid(
      createWorldCaptureModelContent({
        ...content,
        definition: { ...content.definition, placement: { ...content.definition.placement, extra: 1 } }
      })
    );
    expectInvalid(
      createWorldCaptureModelContent({
        ...content,
        definition: {
          ...content.definition,
          contentVersion: { ...content.definition.contentVersion, revision: 0 }
        }
      })
    );
  });

  it("copies and deep-freezes an instance content set without accepting duplicate identities", () => {
    const content = scriptModel("const root = box();");
    const raw: Array<{ instanceId: string; content: WorldCaptureModelContent }> = [
      instanceContent("instance-a", content)
    ];
    const decoded = expectOk(createWorldCaptureInstanceContents(raw));
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded[0].content)).toBe(true);

    raw[0].instanceId = "mutated";
    expect(decoded[0].instanceId).toBe("instance-a");

    expectInvalid(
      createWorldCaptureInstanceContents([
        instanceContent("instance-a", content),
        instanceContent("instance-a", scriptModel("const root = sphere();"))
      ])
    );
  });

  it("distinguishes same instance/pose script and asset versions by fingerprint", () => {
    const oldScript = instanceContent("instance-a", scriptModel("const root = box();"));
    const newScript = instanceContent("instance-a", scriptModel("const root = sphere();"));
    const oldAsset = instanceContent("instance-a", glbModel("asset-old"));
    const newAsset = instanceContent("instance-a", glbModel("asset-new"));

    const fingerprints = [
      worldCaptureContentFingerprint([oldScript]),
      worldCaptureContentFingerprint([newScript]),
      worldCaptureContentFingerprint([oldAsset]),
      worldCaptureContentFingerprint([newAsset])
    ];
    expect(new Set(fingerprints).size).toBe(4);
    expect(EMPTY_WORLD_CAPTURE_CONTENT_FINGERPRINT).not.toBe(fingerprints[0]);
  });

  it("binds instance identity but not instance order into the fingerprint", () => {
    const a = instanceContent("instance-a", scriptModel("const root = box();"));
    const b = instanceContent("instance-b", glbModel("asset-old"));
    expect(worldCaptureContentFingerprint([a, b])).toBe(worldCaptureContentFingerprint([b, a]));
    expect(worldCaptureContentFingerprint([a, b])).not.toBe(
      worldCaptureContentFingerprint([a, instanceContent("instance-c", b.content)])
    );
  });

  it("rejects a resolution request whose fingerprint does not describe its content", () => {
    const instances = [instanceContent("instance-a", scriptModel("const root = box();"))];
    const request = resolutionRequest(instances);
    expect(expectOk(decodeWorldCaptureContentResolutionRequest(request))).toEqual(request);
    expectInvalid(
      decodeWorldCaptureContentResolutionRequest({
        ...request,
        contentFingerprint: worldCaptureContentFingerprint([
          instanceContent("instance-a", scriptModel("const root = sphere();"))
        ])
      })
    );
    expectInvalid(
      decodeWorldCaptureContentResolutionRequest({ ...request, key: { canvasId: "canvas-1" } })
    );
  });

  it("accepts a ready resolution only when every pinned content hash is resolved", () => {
    const oldContent = scriptModel("const root = box();");
    const instances = [instanceContent("instance-a", oldContent)];
    const request = resolutionRequest(instances);
    const oldHash = worldCaptureModelContentHash(oldContent);

    const accepted = verifyWorldCaptureContentResolution(
      request,
      ready(request, [
        { instanceId: "instance-a", contentHash: oldHash, resource: prepared("old-box") }
      ])
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok || accepted.resolution.status !== "ready") throw new Error("expected ready");
    expect(accepted.resolution.resources[0].resource.resourceKey).toBe(
      prepared("old-box").resourceKey
    );

    const currentContent = scriptModel("const root = sphere();");
    const currentHash = worldCaptureModelContentHash(currentContent);
    expect(
      verifyWorldCaptureContentResolution(
        request,
        ready(request, [
          {
            instanceId: "instance-a",
            contentHash: currentHash,
            resource: prepared("current-sphere")
          }
        ])
      )
    ).toMatchObject({ ok: false, code: "content-mismatch" });
  });

  it("rejects missing, extra, duplicate and wrongly identified resolved models", () => {
    const first = scriptModel("const root = box();");
    const second = glbModel("asset-old");
    const request = resolutionRequest([
      instanceContent("instance-a", first),
      instanceContent("instance-b", second)
    ]);
    const firstHash = worldCaptureModelContentHash(first);
    const secondHash = worldCaptureModelContentHash(second);

    expect(
      verifyWorldCaptureContentResolution(
        request,
        ready(request, [
          { instanceId: "instance-a", contentHash: firstHash, resource: prepared("a") }
        ])
      )
    ).toMatchObject({ ok: false, code: "content-mismatch" });
    expect(
      verifyWorldCaptureContentResolution(
        request,
        ready(request, [
          { instanceId: "instance-a", contentHash: firstHash, resource: prepared("a") },
          { instanceId: "instance-b", contentHash: secondHash, resource: prepared("b") },
          { instanceId: "instance-c", contentHash: secondHash, resource: prepared("c") }
        ])
      )
    ).toMatchObject({ ok: false, code: "content-mismatch" });
    expect(
      verifyWorldCaptureContentResolution(
        request,
        ready(request, [
          { instanceId: "instance-a", contentHash: firstHash, resource: prepared("a") },
          { instanceId: "instance-a", contentHash: secondHash, resource: prepared("b") }
        ])
      )
    ).toMatchObject({ ok: false, code: "content-mismatch" });
    expect(
      verifyWorldCaptureContentResolution(
        request,
        ready(request, [
          { instanceId: "instance-a", contentHash: firstHash, resource: prepared("a") },
          { instanceId: "instance-b", contentHash: firstHash, resource: prepared("b") }
        ])
      )
    ).toMatchObject({ ok: false, code: "content-mismatch" });
  });

  it("rejects malformed prepared resources and mismatched request identity", () => {
    const content = scriptModel("const root = box();");
    const request = resolutionRequest([instanceContent("instance-a", content)]);
    const hash = worldCaptureModelContentHash(content);
    const resource = prepared("old-box");
    const badOps = { ...resource, ops: "not-an-array" } as unknown as PreparedModelResource;
    const badExtra = {
      ...resource,
      url: "https://example.invalid"
    } as unknown as PreparedModelResource;

    const cases: unknown[] = [
      ready(request, [
        { instanceId: "instance-a", contentHash: hash, resource: { ...resource, resourceKey: "other:key" } }
      ]),
      ready(request, [{ instanceId: "instance-a", contentHash: hash, resource: badOps }]),
      ready(request, [{ instanceId: "instance-a", contentHash: hash, resource: badExtra }]),
      { ...ready(request, []), requestId: "request-other" },
      { ...ready(request, []), contentFingerprint: EMPTY_WORLD_CAPTURE_CONTENT_FINGERPRINT },
      { ...ready(request, []), version: "world-capture-content-resolution-v0" }
    ];
    for (const resolution of cases) {
      expect(verifyWorldCaptureContentResolution(request, resolution).ok).toBe(false);
    }
    expect(PREPARED_MODEL_RESOURCE_VERSION).toBe(resource.resourceVersion);
  });

  it("keeps waiting and unavailable explicit instead of returning a usable resource", () => {
    const content = scriptModel("const root = box();");
    const request = resolutionRequest([instanceContent("instance-a", content)]);
    for (const resolution of [
      {
        version: WORLD_CAPTURE_CONTENT_RESOLUTION_VERSION,
        status: "waiting",
        requestId: request.requestId,
        contentFingerprint: request.contentFingerprint,
        reason: "resources-not-ready"
      },
      {
        version: WORLD_CAPTURE_CONTENT_RESOLUTION_VERSION,
        status: "unavailable",
        requestId: request.requestId,
        contentFingerprint: request.contentFingerprint,
        reason: "content-unavailable"
      },
      {
        version: WORLD_CAPTURE_CONTENT_RESOLUTION_VERSION,
        status: "unavailable",
        requestId: request.requestId,
        contentFingerprint: request.contentFingerprint,
        reason: "content-replaced"
      }
    ] as const) {
      const verified = verifyWorldCaptureContentResolution(request, resolution);
      expect(verified).toEqual({ ok: true, resolution });
    }
  });
});
