import { describe, expect, it } from "vitest";
import {
  SCENE_AREA_PLAN_CONTRACT_VERSION,
  SCENE_AREA_PLAN_FAILURE_RULES,
  SCENE_AREA_PLAN_FIXTURES,
  type SceneAreaPlanFixture,
  type SceneAreaPlanRequest
} from "./scene-area-plan-contract.js";
import {
  classifySceneAreaPlanRequest,
  createSceneAreaPlanPlanner,
  planSceneAreaOperation,
  sceneAreaPlanPlanner
} from "./scene-area-operation-plan.js";
import { SHARED_WORLD_VERSION } from "./shared-world.js";

function fixture(name: string): SceneAreaPlanFixture {
  const found = SCENE_AREA_PLAN_FIXTURES.find((candidate) => candidate.name === name);
  expect(found, name).toBeDefined();
  return found as SceneAreaPlanFixture;
}

function planFixture(name: string): Extract<SceneAreaPlanFixture["expected"], { kind: "plan" }> {
  const expected = fixture(name).expected;
  expect(expected.kind).toBe("plan");
  return expected as Extract<SceneAreaPlanFixture["expected"], { kind: "plan" }>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function withoutKey(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}

describe("scene area operation plan", () => {
  it("reproduces every frozen success fixture exactly, including command order", () => {
    const successes = SCENE_AREA_PLAN_FIXTURES.filter((candidate) => candidate.expected.kind === "plan");
    expect(successes).toHaveLength(4);

    for (const candidate of successes) {
      const expected = candidate.expected;
      if (expected.kind !== "plan") continue;
      const result = planSceneAreaOperation(candidate.request);
      expect(result.ok, candidate.name).toBe(true);
      if (!result.ok) continue;
      expect(result.plan, candidate.name).toEqual({
        contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
        canvasId: candidate.request.canvasId,
        operationId: candidate.request.operationId,
        intent: candidate.request.intent,
        source: {
          area: candidate.request.area,
          members: candidate.request.members
        },
        commands: expected.commands,
        inverse: expected.inverse
      });
    }
  });

  it("keeps the area first, then fixed instances, then fixed cameras when moving", () => {
    const candidate = fixture("move-fixed-members-preserve-height-and-relative-pose");
    const expected = planFixture(candidate.name);
    const result = planSceneAreaOperation(candidate.request);
    expect(result.ok).toBe(true);
    if (!result.ok || candidate.request.intent !== "move") return;

    expect(result.plan.commands.map((command) => command.kind)).toEqual([
      "set-scene-area-bounds",
      ...candidate.request.members.instances.map(() => "set-instance-transform"),
      ...candidate.request.members.cameras.map(() => "set-world-camera-pose")
    ]);
    expect(result.plan.inverse.map((command) => command.kind)).toEqual([
      "restore-scene-area-bounds",
      ...candidate.request.members.instances.map(() => "restore-instance"),
      ...candidate.request.members.cameras.map(() => "restore-world-camera")
    ]);
    expect(result.plan.commands).toEqual(expected.commands);
    expect(result.plan.inverse).toEqual(expected.inverse);

    for (const member of candidate.request.members.instances) {
      const command = result.plan.commands.find(
        (candidateCommand) =>
          candidateCommand.kind === "set-instance-transform" &&
          candidateCommand.target.instanceId === member.identity.instanceId
      );
      expect(command, member.identity.instanceId).toBeDefined();
      if (!command || command.kind !== "set-instance-transform") continue;
      expect(command.transform.position.h).toBe(member.transform.position.h);
      expect(command.transform.rotation).toEqual(member.transform.rotation);
      expect(command.transform.scale).toBe(member.transform.scale);
      expect(command.transform.position.u).toBe(member.transform.position.u + candidate.request.delta.u);
      expect(command.transform.position.v).toBe(member.transform.position.v + candidate.request.delta.v);
    }

    for (const member of candidate.request.members.cameras) {
      const command = result.plan.commands.find(
        (candidateCommand) =>
          candidateCommand.kind === "set-world-camera-pose" &&
          candidateCommand.target.cameraId === member.identity.cameraId
      );
      expect(command, member.identity.cameraId).toBeDefined();
      if (!command || command.kind !== "set-world-camera-pose") continue;
      expect(command.position).toEqual({
        u: member.camera.position.u + candidate.request.delta.u,
        v: member.camera.position.v + candidate.request.delta.v,
        h: member.camera.position.h
      });
      expect(command.rotation).toEqual(member.camera.rotation);
    }
  });

  it("resizes only the area and never emits object commands", () => {
    const candidate = fixture("resize-bounds-only");
    const expected = planFixture(candidate.name);
    const result = planSceneAreaOperation(candidate.request);
    expect(result.ok).toBe(true);
    if (!result.ok || candidate.request.intent !== "resize") return;

    expect(result.plan.commands).toEqual([
      {
        kind: "set-scene-area-bounds",
        areaId: candidate.request.area.areaId,
        expectedScopeVersion: candidate.request.area.scopeVersion,
        bounds: candidate.request.bounds
      }
    ]);
    expect(result.plan.inverse).toEqual([
      {
        kind: "restore-scene-area-bounds",
        areaId: candidate.request.area.areaId,
        scopeVersion: candidate.request.area.scopeVersion,
        bounds: candidate.request.area.bounds
      }
    ]);
    expect(result.plan.commands).toEqual(expected.commands);
    expect(result.plan.inverse).toEqual(expected.inverse);
    expect(JSON.stringify(result.plan.commands)).not.toContain("instance-a");
    expect(JSON.stringify(result.plan.commands)).not.toContain("camera-c");
  });

  it("deletes only the area by default and keeps the fixed members in the inverse source", () => {
    const candidate = fixture("delete-area-keeps-members-and-media");
    const result = planSceneAreaOperation(candidate.request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.commands).toEqual([
      {
        kind: "delete-scene-area",
        areaId: candidate.request.area.areaId,
        expectedScopeVersion: candidate.request.area.scopeVersion
      }
    ]);
    expect(result.plan.inverse).toEqual([
      {
        kind: "restore-scene-area",
        areaId: candidate.request.area.areaId,
        scopeVersion: candidate.request.area.scopeVersion,
        bounds: candidate.request.area.bounds
      }
    ]);
    expect(result.plan.source).toEqual({ area: candidate.request.area, members: candidate.request.members });
    expect(JSON.stringify(result.plan.commands)).not.toContain("instance-a");
    expect(JSON.stringify(result.plan.commands)).not.toContain("camera-c");
  });

  it("deletes exactly the fixed eligible set, restores it in reverse order and keeps generated media", () => {
    const candidate = fixture("delete-area-with-contents-uses-fixed-eligible-set-and-keeps-media");
    const result = planSceneAreaOperation(candidate.request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const deletedInstances = result.plan.commands
      .filter((command) => command.kind === "delete-instance")
      .map((command) => command.target.instanceId);
    const deletedCameras = result.plan.commands
      .filter((command) => command.kind === "delete-world-camera")
      .map((command) => command.target.cameraId);

    expect(deletedInstances).toEqual(
      candidate.request.members.instances.map((member) => member.identity.instanceId)
    );
    expect(deletedCameras).toEqual(
      candidate.request.members.cameras.map((member) => member.identity.cameraId)
    );
    expect(result.plan.commands.at(-1)?.kind).toBe("delete-scene-area");
    expect(result.plan.inverse[0]?.kind).toBe("restore-scene-area");

    const json = JSON.stringify(result.plan);
    for (const id of candidate.excludedObjectIds ?? []) expect(json).not.toContain(id);
    for (const id of candidate.preservedMediaIds ?? []) expect(json).not.toContain(id);
  });

  it("never emits traversed, partial or read-only objects for any intent", () => {
    for (const candidate of SCENE_AREA_PLAN_FIXTURES) {
      if (candidate.expected.kind !== "plan") continue;
      const result = planSceneAreaOperation(candidate.request);
      expect(result.ok, candidate.name).toBe(true);
      if (!result.ok) continue;
      const commands = JSON.stringify(result.plan.commands);
      const inverse = JSON.stringify(result.plan.inverse);
      for (const id of candidate.excludedObjectIds ?? []) {
        expect(commands, candidate.name).not.toContain(id);
        expect(inverse, candidate.name).not.toContain(id);
      }
      for (const id of candidate.preservedMediaIds ?? []) {
        expect(commands, candidate.name).not.toContain(id);
        expect(inverse, candidate.name).not.toContain(id);
      }
    }
  });

  it("does not mutate the request and does not share mutable values with the plan", () => {
    for (const candidate of SCENE_AREA_PLAN_FIXTURES) {
      if (candidate.expected.kind !== "plan") continue;
      const before = clone(candidate.request);
      const result = planSceneAreaOperation(candidate.request);
      expect(result.ok, candidate.name).toBe(true);
      expect(candidate.request, candidate.name).toEqual(before);
      if (!result.ok) continue;

      expect(result.plan.source.area).not.toBe(candidate.request.area);
      expect(result.plan.source.area.bounds).not.toBe(candidate.request.area.bounds);
      expect(result.plan.source.members).not.toBe(candidate.request.members);
      expect(result.plan.source.members.instances[0]).not.toBe(candidate.request.members.instances[0]);
      expect(result.plan.source.members.cameras[0]).not.toBe(candidate.request.members.cameras[0]);

      result.plan.source.area.bounds.min.u = 999;
      result.plan.source.members.instances[0].transform.position.h = 999;
      result.plan.source.members.cameras[0].camera.position.h = 999;
      expect(candidate.request, candidate.name).toEqual(before);
    }
  });

  it("is deterministic and replays the original fixed set for retries and redo", () => {
    for (const candidate of SCENE_AREA_PLAN_FIXTURES) {
      if (candidate.expected.kind !== "plan") continue;
      const first = planSceneAreaOperation(candidate.request);
      const second = planSceneAreaOperation(candidate.request);
      expect(first, candidate.name).toEqual(second);
      expect(first.ok).toBe(true);
      if (!first.ok || !second.ok) continue;
      expect(second.plan.operationId).toBe(candidate.request.operationId);
      expect(second.plan.intent).toBe(candidate.request.intent);
      expect(second.plan.source).toEqual(first.plan.source);
      expect(second.plan.commands).toEqual(first.plan.commands);
      expect(second.plan.inverse).toEqual(first.plan.inverse);
      expect(second.plan.commands).not.toBe(first.plan.commands);
      expect(second.plan.inverse).not.toBe(first.plan.inverse);
    }
  });

  it("classifies every planner-owned failure fixture with its frozen code", () => {
    const failures = SCENE_AREA_PLAN_FIXTURES.filter((candidate) => candidate.expected.kind === "failure");
    expect(failures.length).toBeGreaterThanOrEqual(Object.keys(SCENE_AREA_PLAN_FAILURE_RULES).length);

    for (const candidate of failures) {
      if (candidate.rule === "operation-intent-reuse") continue;
      expect(candidate.expected.kind).toBe("failure");
      if (candidate.expected.kind !== "failure") continue;
      expect(candidate.rule, candidate.name).toBeDefined();
      const rule = candidate.rule;
      if (!rule) continue;
      expect(SCENE_AREA_PLAN_FAILURE_RULES[rule].code).toBe(candidate.expected.code);
      expect(classifySceneAreaPlanRequest(candidate.request), candidate.name).toBe(candidate.expected.code);
      expect(planSceneAreaOperation(candidate.request), candidate.name).toEqual({
        ok: false,
        code: candidate.expected.code,
        operationId: candidate.request.operationId
      });
    }
  });

  it("leaves operation-intent reuse to the authority receipt", () => {
    const candidate = fixture("failure-operation-intent-reuse");
    expect(candidate.storedIntent).toBe("move");
    expect(candidate.request.intent).toBe("resize");
    // The request itself is a valid resize; only a persisted receipt can reject it.
    expect(classifySceneAreaPlanRequest(candidate.request)).toBeNull();
    const result = planSceneAreaOperation(candidate.request);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.intent).toBe("resize");
  });

  it("fails unknown or unreadable fixed-member snapshots instead of inventing an empty set", () => {
    const move = fixture("move-fixed-members-preserve-height-and-relative-pose").request;
    expect(move.intent).toBe("move");

    const missingMembers = { ...move, members: undefined } as unknown as SceneAreaPlanRequest;
    expect(planSceneAreaOperation(missingMembers)).toMatchObject({
      ok: false,
      code: "unknown-input",
      operationId: move.operationId
    });

    const missingInstances = {
      ...move,
      members: { instances: undefined, cameras: [] }
    } as unknown as SceneAreaPlanRequest;
    expect(planSceneAreaOperation(missingInstances)).toMatchObject({ ok: false, code: "unknown-input" });

    const missingTransform = {
      ...move,
      members: { instances: [{ identity: { kind: "instance", instanceId: "instance-z" }, version: "v1" }], cameras: [] }
    } as unknown as SceneAreaPlanRequest;
    expect(planSceneAreaOperation(missingTransform)).toMatchObject({ ok: false, code: "unknown-input" });
  });

  it("fails unreadable area, transform and camera payload fields as unknown input", () => {
    const move = fixture("move-fixed-members-preserve-height-and-relative-pose").request;
    const resize = fixture("resize-bounds-only").request;

    const expectUnknown = (request: SceneAreaPlanRequest): void => {
      expect(() => classifySceneAreaPlanRequest(request)).not.toThrow();
      expect(classifySceneAreaPlanRequest(request)).toBe("unknown-input");
      expect(() => planSceneAreaOperation(request)).not.toThrow();
      expect(planSceneAreaOperation(request)).toEqual({
        ok: false,
        code: "unknown-input",
        operationId: request.operationId
      });
    };

    // The source area bounds are copied by every intent, including resize.
    expectUnknown({ ...resize, area: { ...resize.area, bounds: undefined } } as unknown as SceneAreaPlanRequest);
    expectUnknown({
      ...move,
      area: { ...move.area, bounds: { min: { u: 0, v: 0 }, max: undefined } }
    } as unknown as SceneAreaPlanRequest);

    const instance = move.members.instances[0];
    for (const transform of [
      { ...instance.transform, position: undefined },
      { ...instance.transform, position: { u: 1, v: 2 } },
      { ...instance.transform, rotation: undefined },
      { ...instance.transform, rotation: [0, 0, 0] as unknown as typeof instance.transform.rotation },
      { ...instance.transform, scale: undefined }
    ]) {
      expectUnknown({
        ...move,
        members: {
          instances: [{ ...instance, transform } as unknown as typeof instance],
          cameras: move.members.cameras
        }
      } as unknown as SceneAreaPlanRequest);
    }

    const member = move.members.cameras[0];
    for (const camera of [
      { ...member.camera, position: undefined },
      { ...member.camera, rotation: undefined },
      { ...member.camera, projection: undefined },
      { ...member.camera, projection: { kind: "perspective", nearMeters: 0.1, farMeters: 100 } },
      { ...member.camera, aspect: undefined },
      { ...member.camera, aspect: { width: 16 } },
      { ...member.camera, captureMode: undefined },
      { ...member.camera, boundInstanceId: undefined }
    ]) {
      expectUnknown({
        ...move,
        members: {
          instances: move.members.instances,
          cameras: [{ ...member, camera } as unknown as typeof member]
        }
      } as unknown as SceneAreaPlanRequest);
    }
  });

  it("rejects a present transform or camera payload without a supported version", () => {
    const move = fixture("move-fixed-members-preserve-height-and-relative-pose").request;
    const instance = move.members.instances[0];
    const cameraMember = move.members.cameras[0];

    const expectFailure = (request: SceneAreaPlanRequest, code: "unsupported-version" | "unknown-input"): void => {
      expect(() => classifySceneAreaPlanRequest(request)).not.toThrow();
      expect(classifySceneAreaPlanRequest(request)).toBe(code);
      expect(() => planSceneAreaOperation(request)).not.toThrow();
      expect(planSceneAreaOperation(request)).toEqual({
        ok: false,
        code,
        operationId: request.operationId
      });
    };

    for (const transform of [
      { ...instance.transform, version: undefined },
      withoutKey(instance.transform, "version"),
      { ...instance.transform, version: 5 }
    ]) {
      expectFailure(
        {
          ...move,
          members: {
            instances: [{ ...instance, transform } as unknown as typeof instance],
            cameras: move.members.cameras
          }
        } as unknown as SceneAreaPlanRequest,
        "unsupported-version"
      );
    }

    for (const camera of [
      { ...cameraMember.camera, version: undefined },
      withoutKey(cameraMember.camera, "version")
    ]) {
      expectFailure(
        {
          ...move,
          members: {
            instances: move.members.instances,
            cameras: [{ ...cameraMember, camera } as unknown as typeof cameraMember]
          }
        } as unknown as SceneAreaPlanRequest,
        "unknown-input"
      );
    }

    expectFailure(
      {
        ...move,
        members: {
          instances: move.members.instances,
          cameras: [
            {
              ...cameraMember,
              camera: { ...cameraMember.camera, version: 5 }
            } as unknown as typeof cameraMember
          ]
        }
      } as unknown as SceneAreaPlanRequest,
      "unsupported-version"
    );
  });

  it("rejects malformed intents, deltas and extra identity shapes as invalid input", () => {
    const move = fixture("move-fixed-members-preserve-height-and-relative-pose").request;

    const unknownIntent = { ...move, intent: "teleport" } as unknown as SceneAreaPlanRequest;
    expect(planSceneAreaOperation(unknownIntent)).toMatchObject({ ok: false, code: "invalid-input" });

    const missingDelta = { ...move, delta: undefined } as unknown as SceneAreaPlanRequest;
    expect(planSceneAreaOperation(missingDelta)).toMatchObject({ ok: false, code: "invalid-input" });

    const wrongKind = {
      ...move,
      members: {
        ...move.members,
        instances: [
          {
            ...move.members.instances[0],
            identity: { kind: "camera", instanceId: move.members.instances[0].identity.instanceId }
          }
        ]
      }
    } as unknown as SceneAreaPlanRequest;
    expect(planSceneAreaOperation(wrongKind)).toMatchObject({ ok: false, code: "invalid-input" });
  });

  it("exposes the planner port through a factory and a stateless singleton", () => {
    const planner = createSceneAreaPlanPlanner();
    const candidate = fixture("move-fixed-members-preserve-height-and-relative-pose");
    expect(planner.plan(candidate.request)).toEqual(sceneAreaPlanPlanner.plan(candidate.request));
    expect(sceneAreaPlanPlanner.plan(candidate.request).ok).toBe(true);
    expect(asRecord(planner).plan).toBeTypeOf("function");
  });

  it("uses the frozen shared-world version in moved transforms", () => {
    const candidate = fixture("move-fixed-members-preserve-height-and-relative-pose");
    const result = planSceneAreaOperation(candidate.request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const command of result.plan.commands) {
      if (command.kind === "set-instance-transform") expect(command.transform.version).toBe(SHARED_WORLD_VERSION);
    }
  });
});
