import { describe, expect, it } from "vitest";
import {
  createWorldCaptureMediaSaveRequest,
  createWorldCaptureRequest,
  resolveWorldCaptureOutcome,
  verifyWorldCaptureMediaSaveReceipt,
  type WorldCaptureImage,
  type WorldCaptureMediaSavePort,
  type WorldCaptureMediaSaveReceipt,
  type WorldCaptureMediaSaveResult,
  type WorldCaptureOutputSpec,
  type WorldCaptureProducerOutcome,
  type WorldCaptureRequest,
  type WorldCaptureSubject
} from "./world-capture-port-contract.js";
import {
  WORLD_CAPTURE_INPUT_VERSION,
  WORLD_CAPTURE_MEDIA_VERSION,
  toWorldCaptureInput,
  type WorldCaptureMediaMetadata
} from "./world-capture-contract.js";
import {
  SHARED_WORLD_VERSION,
  type SharedWorldDecodeResult,
  type WorldCameraData,
  type WorldCaptureVersionKey,
  type WorldInstanceData
} from "./shared-world.js";

const CHECKSUM = "a".repeat(64);
const OUTPUT_VERSION = "output-1920x1080-png-1";

const WORLD_KEY: WorldCaptureVersionKey = {
  canvasId: "canvas-shared-1",
  cameraId: "camera-1",
  worldContentVersion: "world-content-7",
  cameraSettingsVersion: "camera-settings-3",
  bindingVersion: "binding-none-2",
  outputVersion: OUTPUT_VERSION
};

const BOUND_KEY: WorldCaptureVersionKey = {
  ...WORLD_KEY,
  cameraId: "camera-2",
  cameraSettingsVersion: "camera-settings-4",
  bindingVersion: "binding-instance-a-1"
};

const UNBOUND_CAMERA: WorldCameraData = {
  kind: "world-camera",
  version: SHARED_WORLD_VERSION,
  cameraId: WORLD_KEY.cameraId,
  settingsVersion: WORLD_KEY.cameraSettingsVersion,
  position: { u: 0, v: 0, h: 2 },
  rotation: [0, 0, 0, 1],
  projection: { kind: "perspective", verticalFovRadians: Math.PI / 3, nearMeters: 0.1, farMeters: 1000 },
  captureMode: { kind: "static" },
  aspect: { width: 16, height: 9 },
  boundInstanceId: null
};

const BOUND_CAMERA: WorldCameraData = {
  ...UNBOUND_CAMERA,
  cameraId: BOUND_KEY.cameraId,
  settingsVersion: BOUND_KEY.cameraSettingsVersion,
  boundInstanceId: "instance-a"
};

const INSTANCE_A: WorldInstanceData = {
  kind: "world-instance",
  version: SHARED_WORLD_VERSION,
  instanceId: "instance-a",
  transform: {
    version: SHARED_WORLD_VERSION,
    position: { u: 0, v: 0, h: 0 },
    rotation: [0, 0, 0, 1],
    scale: 1
  }
};

const INSTANCE_B: WorldInstanceData = {
  ...INSTANCE_A,
  instanceId: "instance-b",
  transform: {
    ...INSTANCE_A.transform,
    position: { u: 6, v: 0, h: 0 }
  }
};

const OUTPUT: WorldCaptureOutputSpec = {
  outputVersion: OUTPUT_VERSION,
  width: 1920,
  height: 1080,
  contentType: "image/png"
};

function expectOk<T>(result: SharedWorldDecodeResult<T>): T {
  if (!result.ok) throw new Error(`expected a decoded value, got ${result.code}`);
  return result.value;
}

function expectRejectedInput(
  result: SharedWorldDecodeResult<unknown>,
  code: "invalid-data" | "unsupported-version" = "invalid-data"
): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected rejection");
  expect(result.code).toBe(code);
}

function rawWorldRequest(): Record<string, unknown> {
  return {
    requestId: "request-world-1",
    key: WORLD_KEY,
    worldContentVersion: WORLD_KEY.worldContentVersion,
    bindingVersion: WORLD_KEY.bindingVersion,
    camera: UNBOUND_CAMERA,
    subject: { kind: "world", instances: [INSTANCE_A, INSTANCE_B] },
    output: OUTPUT
  };
}

function rawBoundRequest(): Record<string, unknown> {
  return {
    requestId: "request-bound-1",
    key: BOUND_KEY,
    worldContentVersion: BOUND_KEY.worldContentVersion,
    bindingVersion: BOUND_KEY.bindingVersion,
    camera: BOUND_CAMERA,
    subject: { kind: "instance", instanceId: "instance-a", instance: INSTANCE_A },
    output: OUTPUT
  };
}

function rawMissingRequest(): Record<string, unknown> {
  return {
    ...rawBoundRequest(),
    requestId: "request-missing-1",
    subject: { kind: "bound-missing", instanceId: "instance-a" }
  };
}

function makeWorldRequest(): WorldCaptureRequest {
  return expectOk(createWorldCaptureRequest(rawWorldRequest()));
}

function makeBoundRequest(): WorldCaptureRequest {
  return expectOk(createWorldCaptureRequest(rawBoundRequest()));
}

function makeMissingRequest(): WorldCaptureRequest {
  return expectOk(createWorldCaptureRequest(rawMissingRequest()));
}

const CAPTURE_BYTES = new Uint8Array([137, 80, 78, 71]);

function imageFor(
  request: WorldCaptureRequest,
  overrides: Partial<WorldCaptureImage> = {}
): WorldCaptureImage {
  return {
    bytes: new Uint8Array(CAPTURE_BYTES),
    contentType: request.output.contentType,
    width: request.output.width,
    height: request.output.height,
    ...overrides
  };
}

function mediaFor(
  image: WorldCaptureImage,
  overrides: Partial<WorldCaptureMediaMetadata> = {}
): WorldCaptureMediaMetadata {
  return {
    version: WORLD_CAPTURE_MEDIA_VERSION,
    mediaId: "media-capture-1",
    storageKey: `sha256-${CHECKSUM}`,
    checksum: CHECKSUM,
    contentType: image.contentType,
    size: image.bytes.length,
    width: image.width,
    height: image.height,
    ...overrides
  };
}

function receiptFor(
  request: WorldCaptureRequest,
  image: WorldCaptureImage,
  overrides: Partial<WorldCaptureMediaSaveReceipt> = {}
): WorldCaptureMediaSaveReceipt {
  return {
    requestId: request.requestId,
    key: request.key,
    media: mediaFor(image),
    ...overrides
  };
}

function imageOutcome(
  request: WorldCaptureRequest,
  image: WorldCaptureImage
): WorldCaptureProducerOutcome {
  return { status: "image", requestId: request.requestId, key: request.key, image };
}

function saved(receipt: WorldCaptureMediaSaveReceipt): WorldCaptureMediaSaveResult {
  return { status: "saved", receipt };
}

function resolve(
  request: WorldCaptureRequest,
  outcome: WorldCaptureProducerOutcome,
  save?: WorldCaptureMediaSaveResult,
  currentKey: WorldCaptureVersionKey = request.key,
  cancelled = false
) {
  return resolveWorldCaptureOutcome({
    request,
    currentKey,
    cancelled,
    outcome,
    ...(save ? { saved: save } : {})
  });
}

// Compile-time consumer fixtures: T10 prepares a request from a canonical snapshot,
// T09 answers that request, and a trusted port returns stable media metadata.
type T10RequestFactory = (snapshot: {
  requestId: string;
  key: WorldCaptureVersionKey;
  worldContentVersion: string;
  bindingVersion: string;
  camera: WorldCameraData;
  subject: WorldCaptureSubject;
  output: WorldCaptureOutputSpec;
}) => WorldCaptureRequest;

const t10RequestFactory: T10RequestFactory = snapshot => {
  const created = createWorldCaptureRequest(snapshot);
  if (!created.ok) throw new Error(`T10 request rejected: ${created.code}`);
  return created.value;
};

const t09Producer = (
  request: WorldCaptureRequest,
  bytes: Uint8Array
): WorldCaptureProducerOutcome => ({
  status: "image",
  requestId: request.requestId,
  key: request.key,
  image: {
    bytes,
    contentType: request.output.contentType,
    width: request.output.width,
    height: request.output.height
  }
});

const fakeMediaPort: WorldCaptureMediaSavePort = {
  async save(saveRequest) {
    return {
      status: "saved",
      receipt: {
        requestId: saveRequest.requestId,
        key: saveRequest.key,
        media: mediaFor(saveRequest.image)
      }
    };
  }
};

describe("world capture port request", () => {
  it("freezes an unbound whole-world request and copies every nested value", () => {
    const raw = structuredClone(rawWorldRequest());
    const request = t10RequestFactory(raw as Parameters<T10RequestFactory>[0]);

    expect(request.requestId).toBe("request-world-1");
    expect(request.key).toEqual(WORLD_KEY);
    expect(request.worldContentVersion).toBe(WORLD_KEY.worldContentVersion);
    expect(request.bindingVersion).toBe(WORLD_KEY.bindingVersion);
    expect(request.camera.position).toEqual({ u: 0, v: 0, h: 2 });
    expect(request.output).toEqual(OUTPUT);
    expect(request.subject.kind).toBe("world");
    if (request.subject.kind !== "world") throw new Error("expected world subject");
    expect(request.subject.instances.map(instance => instance.instanceId)).toEqual([
      "instance-a",
      "instance-b"
    ]);

    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.key)).toBe(true);
    expect(Object.isFrozen(request.camera)).toBe(true);
    expect(Object.isFrozen(request.output)).toBe(true);
    expect(Object.isFrozen(request.subject.instances)).toBe(true);

    raw.requestId = "request-mutated";
    (raw.key as WorldCaptureVersionKey).worldContentVersion = "world-content-8";
    (raw.camera as WorldCameraData).position.u = 99;
    (raw.output as { width: number }).width = 1;
    (raw.subject as { instances: WorldInstanceData[] }).instances.pop();

    expect(request.requestId).toBe("request-world-1");
    expect(request.key.worldContentVersion).toBe("world-content-7");
    expect(request.camera.position.u).toBe(0);
    expect(request.output.width).toBe(1920);
    if (request.subject.kind !== "world") throw new Error("expected world subject");
    expect(request.subject.instances).toHaveLength(2);
  });

  it("binds exactly one instance and never accepts a whole-world subject for a bound camera", () => {
    const request = makeBoundRequest();
    expect(request.subject.kind).toBe("instance");
    if (request.subject.kind !== "instance") throw new Error("expected instance subject");
    expect(request.subject.instanceId).toBe("instance-a");
    expect(request.subject.instance.instanceId).toBe("instance-a");
    expect(request.camera.boundInstanceId).toBe("instance-a");

    expectRejectedInput(
      createWorldCaptureRequest({
        ...structuredClone(rawWorldRequest()),
        camera: BOUND_CAMERA,
        key: BOUND_KEY,
        worldContentVersion: BOUND_KEY.worldContentVersion,
        bindingVersion: BOUND_KEY.bindingVersion
      })
    );
    expectRejectedInput(
      createWorldCaptureRequest({
        ...structuredClone(rawWorldRequest()),
        subject: { kind: "instance", instanceId: "instance-a", instance: INSTANCE_A }
      })
    );
    expectRejectedInput(
      createWorldCaptureRequest({
        ...structuredClone(rawBoundRequest()),
        subject: { kind: "instance", instanceId: "instance-b", instance: INSTANCE_B }
      })
    );
    expectRejectedInput(
      createWorldCaptureRequest({
        ...structuredClone(rawBoundRequest()),
        subject: { kind: "instance", instanceId: "instance-a", instance: INSTANCE_B }
      })
    );
    expectRejectedInput(
      createWorldCaptureRequest({
        ...structuredClone(rawBoundRequest()),
        subject: { kind: "bound-missing", instanceId: "instance-a" },
        camera: UNBOUND_CAMERA,
        key: WORLD_KEY,
        worldContentVersion: WORLD_KEY.worldContentVersion,
        bindingVersion: WORLD_KEY.bindingVersion
      })
    );
  });

  it("keeps a missing bound target explicit instead of falling back to the whole world", () => {
    const request = makeMissingRequest();
    expect(request.subject.kind).toBe("bound-missing");
    if (request.subject.kind !== "bound-missing") throw new Error("expected missing subject");
    expect(request.subject.instanceId).toBe("instance-a");

    const image = imageFor(request);
    expect(resolve(request, imageOutcome(request, image))).toMatchObject({
      status: "rejected",
      code: "bound-target-missing"
    });
    expect(
      createWorldCaptureMediaSaveRequest(request, image)
    ).toMatchObject({ ok: false, code: "invalid-data" });
    expect(
      resolve(request, {
        status: "waiting",
        requestId: request.requestId,
        key: request.key,
        reason: "resources-not-ready"
      })
    ).toMatchObject({ status: "unavailable", reason: "bound-target-missing" });
    expect(
      resolve(request, {
        status: "unavailable",
        requestId: request.requestId,
        key: request.key,
        reason: "bound-target-missing"
      })
    ).toMatchObject({ status: "unavailable", reason: "bound-target-missing" });
  });

  it("rejects mismatched world, binding, camera and output version provenance", () => {
    const cases: Array<Record<string, unknown>> = [
      { worldContentVersion: "world-content-8" },
      { bindingVersion: "binding-other-1" },
      { output: { ...OUTPUT, outputVersion: "output-other-1" } },
      { camera: { ...UNBOUND_CAMERA, cameraId: "camera-other" } },
      { camera: { ...UNBOUND_CAMERA, settingsVersion: "camera-settings-other" } }
    ];
    for (const patch of cases) {
      expectRejectedInput(createWorldCaptureRequest({ ...structuredClone(rawWorldRequest()), ...patch }));
    }
  });

  it("rejects dynamic capture and non-static output protocol fields", () => {
    expectRejectedInput(
      createWorldCaptureRequest({
        ...structuredClone(rawWorldRequest()),
        camera: { ...UNBOUND_CAMERA, captureMode: { kind: "dynamic" } }
      })
    );
    expectRejectedInput(
      createWorldCaptureRequest({
        ...structuredClone(rawWorldRequest()),
        timeline: { startSeconds: 0, endSeconds: 1 }
      })
    );
    expectRejectedInput(
      createWorldCaptureRequest({
        ...structuredClone(rawWorldRequest()),
        output: { ...OUTPUT, frameRate: 30 }
      })
    );
    expectRejectedInput(
      createWorldCaptureRequest({
        ...structuredClone(rawWorldRequest()),
        output: { ...OUTPUT, contentType: "video/mp4" }
      })
    );
  });

  it("rejects invalid pixel dimensions without confusing them with byte size", () => {
    for (const width of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expectRejectedInput(
        createWorldCaptureRequest({
          ...structuredClone(rawWorldRequest()),
          output: { ...OUTPUT, width }
        })
      );
    }
    expectRejectedInput(
      createWorldCaptureRequest({
        ...structuredClone(rawWorldRequest()),
        output: { ...OUTPUT, height: 0 }
      })
    );
    expectRejectedInput(
      createWorldCaptureRequest({
        ...structuredClone(rawWorldRequest()),
        output: { ...OUTPUT, width: 1920, height: 1.5 }
      })
    );

    const request = makeWorldRequest();
    expect(
      resolve(request, imageOutcome(request, imageFor(request, { width: 0 })))
    ).toMatchObject({ status: "rejected", code: "invalid-image" });
    expect(
      resolve(request, imageOutcome(request, imageFor(request, { height: -1 })))
    ).toMatchObject({ status: "rejected", code: "invalid-image" });
    expect(
      resolve(request, imageOutcome(request, imageFor(request, { width: 1921 })))
    ).toMatchObject({ status: "rejected", code: "invalid-image" });
    expect(
      resolve(request, imageOutcome(request, imageFor(request, { bytes: new Uint8Array() })))
    ).toMatchObject({ status: "rejected", code: "invalid-image" });
    expect(
      resolve(
        request,
        imageOutcome(request, imageFor(request, { contentType: "image/jpeg" }))
      )
    ).toMatchObject({ status: "rejected", code: "invalid-image" });
  });

  it("rejects a producer result whose request identity does not match", () => {
    const request = makeWorldRequest();
    const image = imageFor(request);

    expect(
      resolve(request, {
        status: "image",
        requestId: "request-other",
        key: request.key,
        image
      })
    ).toMatchObject({ status: "rejected", code: "request-mismatch" });

    expect(
      resolve(request, {
        status: "image",
        requestId: request.requestId,
        key: { ...request.key, outputVersion: "output-other" },
        image
      })
    ).toMatchObject({ status: "rejected", code: "request-mismatch" });
  });

  it("keeps cancellation, replacement, waiting, unavailable and failure distinct", () => {
    const request = makeWorldRequest();
    const image = imageFor(request);
    const outcome = imageOutcome(request, image);
    const save = saved(receiptFor(request, image));

    const changedKey = { ...request.key, worldContentVersion: "world-content-8" };
    expect(resolve(request, outcome, save, changedKey)).toMatchObject({
      status: "superseded",
      requestedKey: request.key,
      currentKey: changedKey
    });
    expect(resolve(request, outcome, save, changedKey, true)).toMatchObject({
      status: "cancelled"
    });
    expect(resolve(request, outcome, save, request.key, true)).toMatchObject({
      status: "cancelled"
    });
    expect(
      resolve(request, {
        status: "cancelled",
        requestId: request.requestId,
        key: request.key
      })
    ).toMatchObject({ status: "cancelled" });
    expect(
      resolve(request, {
        status: "waiting",
        requestId: request.requestId,
        key: request.key,
        reason: "resources-not-ready"
      })
    ).toMatchObject({ status: "waiting", reason: "resources-not-ready" });
    expect(
      resolve(request, {
        status: "unavailable",
        requestId: request.requestId,
        key: request.key,
        reason: "renderer-unavailable"
      })
    ).toMatchObject({ status: "unavailable", reason: "renderer-unavailable" });
    expect(
      resolve(makeBoundRequest(), {
        status: "unavailable",
        requestId: "request-bound-1",
        key: BOUND_KEY,
        reason: "bound-target-missing"
      })
    ).toMatchObject({ status: "unavailable", reason: "bound-target-missing" });
    expect(
      resolve(request, {
        status: "unavailable",
        requestId: request.requestId,
        key: request.key,
        reason: "bound-target-missing"
      })
    ).toMatchObject({ status: "rejected", code: "invalid-data" });
    expect(
      resolve(request, {
        status: "failed",
        requestId: request.requestId,
        key: request.key,
        code: "render-failed"
      })
    ).toMatchObject({ status: "failed", code: "render-failed" });
    expect(
      resolve(request, {
        status: "failed",
        requestId: request.requestId,
        key: request.key,
        code: "readback-failed"
      })
    ).toMatchObject({ status: "failed", code: "readback-failed" });
    expect(
      resolve(request, {
        status: "failed",
        requestId: request.requestId,
        key: request.key,
        code: "invalid-output"
      })
    ).toMatchObject({ status: "failed", code: "invalid-output" });
  });

  it("rejects malformed producer outcomes and unsupported reasons", () => {
    const request = makeWorldRequest();
    expect(
      resolve(request, { status: "waiting", requestId: request.requestId, key: request.key, reason: "later" } as unknown as WorldCaptureProducerOutcome)
    ).toMatchObject({ status: "rejected", code: "invalid-data" });
    expect(
      resolve(request, { requestId: request.requestId, key: request.key } as unknown as WorldCaptureProducerOutcome)
    ).toMatchObject({ status: "rejected", code: "invalid-data" });
  });
});

describe("world capture port media boundary", () => {
  it("requires a trusted media save before the temporary image becomes frozen input", () => {
    const request = makeWorldRequest();
    const image = imageFor(request);
    const pending = resolve(request, imageOutcome(request, image));

    expect(pending.status).toBe("media-required");
    if (pending.status !== "media-required") throw new Error("expected media-required");
    expect(pending.image.bytes).not.toBe(image.bytes);
    const originalFirstByte = pending.image.bytes[0];
    image.bytes[0] = 0;
    expect(pending.image.bytes[0]).toBe(originalFirstByte);
  });

  it("freezes only verified v2 media for the exact request, key and pixels", () => {
    const request = makeWorldRequest();
    const image = imageFor(request);
    const receipt = structuredClone(receiptFor(request, image));
    const result = resolve(request, imageOutcome(request, image), saved(receipt));

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.input.version).toBe(WORLD_CAPTURE_INPUT_VERSION);
    expect(result.input.key).toEqual(request.key);
    expect(result.input.media).toEqual(mediaFor(image));
    expect(toWorldCaptureInput(result.input)).toEqual({
      key: request.key,
      mediaId: "media-capture-1",
      checksum: CHECKSUM
    });

    receipt.media.mediaId = "mutated-media";
    receipt.media.width = 1;
    receipt.key.worldContentVersion = "mutated-world";
    expect(result.input.media.mediaId).toBe("media-capture-1");
    expect(result.input.media.width).toBe(1920);
    expect(result.input.key.worldContentVersion).toBe("world-content-7");
  });

  it("reports media save failure without freezing the temporary image", () => {
    const request = makeWorldRequest();
    const image = imageFor(request);
    const outcome = imageOutcome(request, image);

    expect(
      resolve(request, outcome, {
        status: "failed",
        requestId: request.requestId,
        key: request.key,
        code: "write-failed"
      })
    ).toMatchObject({ status: "failed", code: "media-save-failed" });
    expect(
      resolve(request, outcome, {
        status: "failed",
        requestId: request.requestId,
        key: request.key,
        code: "verification-failed"
      })
    ).toMatchObject({ status: "failed", code: "media-verification-failed" });
    expect(
      resolve(request, outcome, {
        status: "cancelled",
        requestId: request.requestId,
        key: request.key
      })
    ).toMatchObject({ status: "cancelled" });
  });

  it("rejects a save receipt for another request or key", () => {
    const request = makeWorldRequest();
    const image = imageFor(request);
    const outcome = imageOutcome(request, image);

    expect(
      resolve(
        request,
        outcome,
        saved(receiptFor(request, image, { requestId: "request-other" }))
      )
    ).toMatchObject({ status: "rejected", code: "media-unverified" });
    expect(
      resolve(
        request,
        outcome,
        saved(receiptFor(request, image, { key: { ...request.key, canvasId: "canvas-other" } }))
      )
    ).toMatchObject({ status: "rejected", code: "media-unverified" });
  });

  it("rejects media whose byte size, pixel size, type or envelope is not trustworthy", () => {
    const request = makeWorldRequest();
    const image = imageFor(request);
    const outcome = imageOutcome(request, image);

    const cases: Array<WorldCaptureMediaMetadata> = [
      mediaFor(image, { width: 1921 }),
      mediaFor(image, { height: 1081 }),
      mediaFor(image, { contentType: "image/jpeg" }),
      // Byte size deliberately set to the pixel width; this must not pass.
      mediaFor(image, { size: image.width }),
      { ...mediaFor(image), version: "world-capture-media-v1" as typeof WORLD_CAPTURE_MEDIA_VERSION },
      { ...mediaFor(image), url: "https://example.invalid/capture.png" } as WorldCaptureMediaMetadata
    ];
    for (const media of cases) {
      expect(resolve(request, outcome, saved(receiptFor(request, image, { media })))).toMatchObject({
        status: "rejected",
        code: "media-unverified"
      });
    }
  });

  it("copies temporary bytes into the media save request and keeps exact request identity", () => {
    const request = makeBoundRequest();
    const image = imageFor(request);
    const saveRequest = expectOk(createWorldCaptureMediaSaveRequest(request, image));

    expect(saveRequest.requestId).toBe(request.requestId);
    expect(saveRequest.key).toEqual(request.key);
    expect(saveRequest.image).toEqual(image);
    expect(saveRequest.image.bytes).not.toBe(image.bytes);

    image.bytes[0] = 0;
    expect(saveRequest.image.bytes[0]).toBe(CAPTURE_BYTES[0]);

    expect(
      createWorldCaptureMediaSaveRequest(request, imageFor(request, { width: 1 }))
    ).toMatchObject({ ok: false, code: "invalid-data" });
    expect(
      createWorldCaptureMediaSaveRequest(request, imageFor(request, { bytes: new Uint8Array() }))
    ).toMatchObject({ ok: false, code: "invalid-data" });
  });

  it("verifies a receipt independently of the resolution pipeline", () => {
    const request = makeWorldRequest();
    const image = imageFor(request);
    const receipt = receiptFor(request, image);

    expect(verifyWorldCaptureMediaSaveReceipt(request, image, receipt)).toEqual({
      ok: true,
      media: mediaFor(image)
    });
    expect(
      verifyWorldCaptureMediaSaveReceipt(
        request,
        image,
        receiptFor(request, image, { requestId: "request-other" })
      )
    ).toEqual({ ok: false, code: "request-mismatch" });
    expect(
      verifyWorldCaptureMediaSaveReceipt(
        request,
        image,
        receiptFor(request, image, { media: mediaFor(image, { size: image.width }) })
      )
    ).toEqual({ ok: false, code: "media-unverified" });
  });

  it("runs the T10 -> T09 -> trusted-port fixture without sharing mutable bytes", async () => {
    const request = t10RequestFactory({
      requestId: "request-fixture-1",
      key: WORLD_KEY,
      worldContentVersion: WORLD_KEY.worldContentVersion,
      bindingVersion: WORLD_KEY.bindingVersion,
      camera: UNBOUND_CAMERA,
      subject: { kind: "world", instances: [INSTANCE_A, INSTANCE_B] },
      output: OUTPUT
    });
    const outcome = t09Producer(request, new Uint8Array(CAPTURE_BYTES));
    const pending = resolve(request, outcome);
    if (pending.status !== "media-required") throw new Error("expected media-required");

    const saveRequest = expectOk(
      createWorldCaptureMediaSaveRequest(request, pending.image)
    );
    const saveResult = await fakeMediaPort.save(saveRequest);
    const result = resolve(request, outcome, saveResult);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.input.media.width).toBe(OUTPUT.width);
    expect(result.input.media.height).toBe(OUTPUT.height);
    expect(result.input.media.size).toBe(CAPTURE_BYTES.length);
  });
});
