import { describe, expect, it } from "vitest";
import {
  SCENE_AREA_PLAN_AREA_KEYS,
  SCENE_AREA_PLAN_CAMERA_MEMBER_KEYS,
  SCENE_AREA_PLAN_CAMERA_IDENTITY_KEYS,
  SCENE_AREA_PLAN_COMMAND_KINDS,
  SCENE_AREA_PLAN_COMMAND_KEYS,
  SCENE_AREA_PLAN_CONTRACT_VERSION,
  SCENE_AREA_PLAN_EXCLUDED_DOMAINS,
  SCENE_AREA_PLAN_FAILURE_CODES,
  SCENE_AREA_PLAN_FAILURE_PRECEDENCE,
  SCENE_AREA_PLAN_FAILURE_RULES,
  SCENE_AREA_PLAN_FIXTURES,
  SCENE_AREA_PLAN_IDEMPOTENCY,
  SCENE_AREA_PLAN_INSTANCE_IDENTITY_KEYS,
  SCENE_AREA_PLAN_INSTANCE_MEMBER_KEYS,
  SCENE_AREA_PLAN_INVERSE_COMMAND_KINDS,
  SCENE_AREA_PLAN_INVERSE_COMMAND_KEYS,
  SCENE_AREA_PLAN_KEYS,
  SCENE_AREA_PLAN_MEMBERS_KEYS,
  SCENE_AREA_PLAN_REQUEST_KEYS,
  SCENE_AREA_PLAN_RESULT_KEYS,
  SCENE_AREA_PLAN_SOURCE_KEYS,
  type SceneAreaPlan,
  type SceneAreaPlanFailureRuleId,
  type SceneAreaPlanFixture,
  type SceneAreaPlanInverseCommand,
  type SceneAreaPlanRequest
} from "./scene-area-plan-contract.js";
import { hasOnlyKeys } from "./shared-world-codec.js";
import { SHARED_WORLD_VERSION, type GroundAabb } from "./shared-world.js";

const INTENTS = ["move", "resize", "delete-area", "delete-area-with-contents"] as const;

function fixture(name: string): SceneAreaPlanFixture {
  const found = SCENE_AREA_PLAN_FIXTURES.find((candidate) => candidate.name === name);
  expect(found, name).toBeDefined();
  return found as SceneAreaPlanFixture;
}

function failureFixture(rule: SceneAreaPlanFailureRuleId): SceneAreaPlanFixture {
  const found = SCENE_AREA_PLAN_FIXTURES.find((candidate) => candidate.rule === rule);
  expect(found, rule).toBeDefined();
  return found as SceneAreaPlanFixture;
}

function planFixture(name: string): Extract<SceneAreaPlanFixture["expected"], { kind: "plan" }> {
  const expected = fixture(name).expected;
  expect(expected.kind).toBe("plan");
  return expected as Extract<SceneAreaPlanFixture["expected"], { kind: "plan" }>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function translated(bounds: GroundAabb, delta: { u: number; v: number }): GroundAabb {
  return {
    min: { u: bounds.min.u + delta.u, v: bounds.min.v + delta.v },
    max: { u: bounds.max.u + delta.u, v: bounds.max.v + delta.v }
  };
}

function expectNotReferenced(commands: readonly unknown[], ids: readonly string[]): void {
  const json = JSON.stringify(commands);
  for (const id of ids) expect(json, id).not.toContain(id);
}

function hasNonFiniteNumber(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasNonFiniteNumber);
  if (value && typeof value === "object") return Object.values(value).some(hasNonFiniteNumber);
  return false;
}

function identityIds(request: SceneAreaPlanRequest): string[] {
  return [
    ...request.members.instances.map((member) => member.identity.instanceId),
    ...request.members.cameras.map((member) => member.identity.cameraId)
  ];
}

/**
 * One predicate per taxonomy rule. The tests use this table to prove that each
 * fixture actually violates the rule it claims and that no fixture is ambiguous.
 */
const RULE_PREDICATES: Readonly<Record<SceneAreaPlanFailureRuleId, (request: SceneAreaPlanRequest) => boolean>> = {
  "unsupported-contract-version": (request) => request.contractVersion !== SCENE_AREA_PLAN_CONTRACT_VERSION,
  "unsupported-transform-version": (request) =>
    request.members.instances.some(
      (member) => member.transform !== undefined && member.transform.version !== SHARED_WORLD_VERSION
    ),
  "unsupported-camera-version": (request) =>
    request.members.cameras.some(
      (member) => member.camera !== undefined && member.camera.version !== SHARED_WORLD_VERSION
    ),
  "missing-area-scope-version": (request) => !request.area.scopeVersion,
  "missing-member-version": (request) =>
    request.members.instances.some((member) => !member.version) ||
    request.members.cameras.some((member) => !member.version),
  "missing-member-payload": (request) =>
    request.members.instances.some((member) => !member.transform) ||
    request.members.cameras.some((member) => !member.camera),
  "empty-canvas-id": (request) => !request.canvasId,
  "empty-operation-id": (request) => !request.operationId,
  "empty-area-id": (request) => !request.area.areaId,
  "empty-identity-id": (request) => identityIds(request).some((id) => !id),
  "non-finite-number": (request) => hasNonFiniteNumber(request),
  "unordered-bounds": (request) => {
    const bounds = request.intent === "resize" ? request.bounds : request.area.bounds;
    return bounds.min.u > bounds.max.u || bounds.min.v > bounds.max.v;
  },
  "duplicate-member-identity": (request) => {
    const versions = new Map<string, Set<string>>();
    const counts = new Map<string, number>();
    for (const member of request.members.instances) {
      const id = member.identity.instanceId;
      const seen = versions.get(id) ?? new Set<string>();
      seen.add(member.version);
      versions.set(id, seen);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...versions.entries()].some(([id, seen]) => seen.size === 1 && (counts.get(id) ?? 0) > 1);
  },
  "camera-identity-mismatch": (request) =>
    request.members.cameras.some((member) => member.identity.cameraId !== member.camera.cameraId),
  "duplicate-identity-version-contradiction": (request) => {
    const versions = new Map<string, Set<string>>();
    for (const member of request.members.instances) {
      const seen = versions.get(member.identity.instanceId) ?? new Set<string>();
      seen.add(member.version);
      versions.set(member.identity.instanceId, seen);
    }
    return [...versions.values()].some((seen) => seen.size > 1);
  },
  "camera-version-contradiction": (request) =>
    request.members.cameras.some((member) => member.version !== member.camera.settingsVersion),
  "operation-intent-reuse": (request) => {
    const candidate = SCENE_AREA_PLAN_FIXTURES.find((item) => item.request === request);
    return candidate?.storedIntent !== undefined && candidate.storedIntent !== request.intent;
  }
};

describe("scene area plan contract", () => {
  it("freezes the public allowlists and the excluded authority domains", () => {
    expect(SCENE_AREA_PLAN_CONTRACT_VERSION).toBe("scene-area-plan-v1");
    expect(SCENE_AREA_PLAN_KEYS).toEqual([
      "contractVersion",
      "canvasId",
      "operationId",
      "intent",
      "source",
      "commands",
      "inverse"
    ]);
    expect(SCENE_AREA_PLAN_SOURCE_KEYS).toEqual(["area", "members"]);
    expect(SCENE_AREA_PLAN_AREA_KEYS).toEqual(["areaId", "scopeVersion", "bounds"]);
    expect(SCENE_AREA_PLAN_MEMBERS_KEYS).toEqual(["instances", "cameras"]);
    expect(SCENE_AREA_PLAN_INSTANCE_MEMBER_KEYS).toEqual(["identity", "version", "transform"]);
    expect(SCENE_AREA_PLAN_CAMERA_MEMBER_KEYS).toEqual(["identity", "version", "camera"]);
    expect(SCENE_AREA_PLAN_RESULT_KEYS).toEqual({
      ok: ["ok", "plan"],
      failure: ["ok", "code", "operationId"]
    });
    expect(SCENE_AREA_PLAN_COMMAND_KINDS).toEqual([
      "set-scene-area-bounds",
      "set-instance-transform",
      "set-world-camera-pose",
      "delete-scene-area",
      "delete-instance",
      "delete-world-camera"
    ]);
    expect(SCENE_AREA_PLAN_INVERSE_COMMAND_KINDS).toEqual([
      "restore-scene-area-bounds",
      "restore-scene-area",
      "restore-instance",
      "restore-world-camera"
    ]);
    expect([...SCENE_AREA_PLAN_FAILURE_CODES].sort()).toEqual([
      "invalid-input",
      "operation-conflict",
      "source-version-conflict",
      "unknown-input",
      "unsupported-version"
    ]);

    for (const keys of Object.values(SCENE_AREA_PLAN_COMMAND_KEYS)) {
      for (const forbidden of ["mediaId", "taskId", "assetId", "lease", "epoch", "runId"]) {
        expect(keys).not.toContain(forbidden);
      }
    }
    for (const keys of Object.values(SCENE_AREA_PLAN_INVERSE_COMMAND_KEYS)) {
      for (const forbidden of ["mediaId", "taskId", "assetId", "lease", "epoch", "runId"]) {
        expect(keys).not.toContain(forbidden);
      }
    }
    for (const domain of ["lease", "commit", "storage", "media", "task", "asset", "history"]) {
      expect(SCENE_AREA_PLAN_EXCLUDED_DOMAINS).toContain(domain);
    }
  });

  it("freezes one failure code per taxonomy rule and an ordered, total precedence", () => {
    const rules = Object.keys(SCENE_AREA_PLAN_FAILURE_RULES) as SceneAreaPlanFailureRuleId[];
    expect([...SCENE_AREA_PLAN_FAILURE_PRECEDENCE].sort()).toEqual([...rules].sort());
    expect(new Set(SCENE_AREA_PLAN_FAILURE_PRECEDENCE).size).toBe(SCENE_AREA_PLAN_FAILURE_PRECEDENCE.length);

    const stageOrder = ["version", "snapshot", "shape", "contradiction", "authority"] as const;
    let lastStage = -1;
    for (const rule of SCENE_AREA_PLAN_FAILURE_PRECEDENCE) {
      const stage = stageOrder.indexOf(SCENE_AREA_PLAN_FAILURE_RULES[rule].stage);
      expect(stage, rule).toBeGreaterThanOrEqual(lastStage);
      lastStage = stage;
      expect(SCENE_AREA_PLAN_FAILURE_CODES, rule).toContain(SCENE_AREA_PLAN_FAILURE_RULES[rule].code);
      expect(SCENE_AREA_PLAN_FAILURE_RULES[rule].description.length, rule).toBeGreaterThan(0);
    }
  });

  it("covers exactly the four intents", () => {
    const intents = SCENE_AREA_PLAN_FIXTURES.map((candidate) => candidate.request.intent);
    expect(new Set(intents)).toEqual(new Set(INTENTS));
    for (const intent of INTENTS) {
      expect(intents.filter((candidate) => candidate === intent).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("puts every fixture request and expected command on the frozen allowlist", () => {
    for (const candidate of SCENE_AREA_PLAN_FIXTURES) {
      const request = asRecord(candidate.request);
      expect(hasOnlyKeys(request, SCENE_AREA_PLAN_REQUEST_KEYS[candidate.request.intent]), candidate.name).toBe(true);
      expect(hasOnlyKeys(asRecord(request.area), SCENE_AREA_PLAN_AREA_KEYS), candidate.name).toBe(true);
      expect(hasOnlyKeys(asRecord(request.members), SCENE_AREA_PLAN_MEMBERS_KEYS), candidate.name).toBe(true);
      for (const member of candidate.request.members.instances) {
        expect(hasOnlyKeys(asRecord(member), SCENE_AREA_PLAN_INSTANCE_MEMBER_KEYS), candidate.name).toBe(true);
        expect(hasOnlyKeys(asRecord(member.identity), SCENE_AREA_PLAN_INSTANCE_IDENTITY_KEYS), candidate.name).toBe(true);
      }
      for (const member of candidate.request.members.cameras) {
        expect(hasOnlyKeys(asRecord(member), SCENE_AREA_PLAN_CAMERA_MEMBER_KEYS), candidate.name).toBe(true);
        expect(hasOnlyKeys(asRecord(member.identity), SCENE_AREA_PLAN_CAMERA_IDENTITY_KEYS), candidate.name).toBe(true);
      }

      if (candidate.expected.kind !== "plan") continue;
      for (const command of candidate.expected.commands) {
        expect(
          hasOnlyKeys(asRecord(command), SCENE_AREA_PLAN_COMMAND_KEYS[command.kind]),
          `${candidate.name}:${command.kind}`
        ).toBe(true);
      }
      for (const command of candidate.expected.inverse) {
        expect(
          hasOnlyKeys(asRecord(command), SCENE_AREA_PLAN_INVERSE_COMMAND_KEYS[command.kind]),
          `${candidate.name}:${command.kind}`
        ).toBe(true);
      }
    }
  });

  it("keeps every successful plan fixture a plain JSON value", () => {
    const plans = SCENE_AREA_PLAN_FIXTURES.filter((candidate) => candidate.expected.kind === "plan");
    expect(plans.length).toBe(INTENTS.length);
    expect(JSON.parse(JSON.stringify(plans))).toEqual(plans);
  });

  it("moves only the fixed members by one ground delta and preserves height and relative pose", () => {
    const request = fixture("move-fixed-members-preserve-height-and-relative-pose").request;
    expect(request.intent).toBe("move");
    if (request.intent !== "move") return;
    const expected = planFixture("move-fixed-members-preserve-height-and-relative-pose");
    const delta = request.delta;

    const areaCommand = expected.commands[0];
    expect(areaCommand).toMatchObject({ kind: "set-scene-area-bounds", areaId: request.area.areaId });
    if (areaCommand.kind !== "set-scene-area-bounds") return;
    expect(areaCommand.expectedScopeVersion).toBe(request.area.scopeVersion);
    expect(areaCommand.bounds).toEqual(translated(request.area.bounds, delta));

    const instanceCommands = expected.commands.filter((command) => command.kind === "set-instance-transform");
    expect(instanceCommands).toHaveLength(request.members.instances.length);
    for (const member of request.members.instances) {
      const command = instanceCommands.find((candidate) => candidate.target.instanceId === member.identity.instanceId);
      expect(command, member.identity.instanceId).toBeDefined();
      if (!command) continue;
      expect(command.expectedVersion).toBe(member.version);
      expect(command.transform.position).toEqual({
        u: member.transform.position.u + delta.u,
        v: member.transform.position.v + delta.v,
        h: member.transform.position.h
      });
      expect(command.transform.rotation).toEqual(member.transform.rotation);
      expect(command.transform.scale).toBe(member.transform.scale);
      expect(command.transform.version).toBe(SHARED_WORLD_VERSION);
    }

    const cameraCommands = expected.commands.filter((command) => command.kind === "set-world-camera-pose");
    expect(cameraCommands).toHaveLength(request.members.cameras.length);
    for (const member of request.members.cameras) {
      const command = cameraCommands.find((candidate) => candidate.target.cameraId === member.identity.cameraId);
      expect(command, member.identity.cameraId).toBeDefined();
      if (!command) continue;
      expect(command.expectedVersion).toBe(member.version);
      expect(command.position).toEqual({
        u: member.camera.position.u + delta.u,
        v: member.camera.position.v + delta.v,
        h: member.camera.position.h
      });
      expect(command.rotation).toEqual(member.camera.rotation);
    }
  });

  it("emits an exact inverse snapshot, including the source area scope version, for all four intents", () => {
    for (const candidate of SCENE_AREA_PLAN_FIXTURES) {
      if (candidate.expected.kind !== "plan") continue;
      const expected = candidate.expected;
      const request = candidate.request;

      const restoredBounds = expected.inverse.filter(
        (command): command is Extract<SceneAreaPlanInverseCommand, { kind: "restore-scene-area-bounds" }> =>
          command.kind === "restore-scene-area-bounds"
      );
      const restoredAreas = expected.inverse.filter(
        (command): command is Extract<SceneAreaPlanInverseCommand, { kind: "restore-scene-area" }> =>
          command.kind === "restore-scene-area"
      );
      expect([...restoredBounds, ...restoredAreas], candidate.name).toHaveLength(1);
      const restored = restoredBounds[0] ?? restoredAreas[0];
      expect(restored.areaId).toBe(request.area.areaId);
      expect(restored.scopeVersion).toBe(request.area.scopeVersion);
      expect(restored.bounds).toEqual(request.area.bounds);

      const restoresMembers =
        candidate.name === "move-fixed-members-preserve-height-and-relative-pose" ||
        candidate.name === "delete-area-with-contents-uses-fixed-eligible-set-and-keeps-media";
      for (const member of request.members.instances) {
        const command = expected.inverse.find(
          (candidateCommand): candidateCommand is Extract<SceneAreaPlanInverseCommand, { kind: "restore-instance" }> =>
            candidateCommand.kind === "restore-instance" &&
            candidateCommand.target.instanceId === member.identity.instanceId
        );
        if (!restoresMembers) {
          expect(command, `${candidate.name}:${member.identity.instanceId}`).toBeUndefined();
          continue;
        }
        expect(command, `${candidate.name}:${member.identity.instanceId}`).toBeDefined();
        if (!command) continue;
        expect(command.version).toBe(member.version);
        expect(command.transform).toEqual(member.transform);
      }

      for (const member of request.members.cameras) {
        const command = expected.inverse.find(
          (candidateCommand): candidateCommand is Extract<SceneAreaPlanInverseCommand, { kind: "restore-world-camera" }> =>
            candidateCommand.kind === "restore-world-camera" &&
            candidateCommand.target.cameraId === member.identity.cameraId
        );
        if (!restoresMembers) {
          expect(command, `${candidate.name}:${member.identity.cameraId}`).toBeUndefined();
          continue;
        }
        expect(command, `${candidate.name}:${member.identity.cameraId}`).toBeDefined();
        if (!command) continue;
        expect(command.version).toBe(member.version);
        expect(command.camera).toEqual(member.camera);
      }
    }
  });

  it("resizes bounds only and never emits object commands", () => {
    const request = fixture("resize-bounds-only").request;
    expect(request.intent).toBe("resize");
    const expected = planFixture("resize-bounds-only");
    expect(expected.commands).toHaveLength(1);
    expect(expected.commands[0]).toMatchObject({
      kind: "set-scene-area-bounds",
      areaId: request.area.areaId,
      expectedScopeVersion: request.area.scopeVersion
    });
    if (request.intent === "resize") {
      expect(expected.commands[0]).toMatchObject({ bounds: request.bounds });
    }
    expect(expected.inverse).toHaveLength(1);
    expect(expected.inverse[0].kind).toBe("restore-scene-area-bounds");
    expectNotReferenced(expected.commands, request.members.instances.map((member) => member.identity.instanceId));
    expectNotReferenced(expected.commands, request.members.cameras.map((member) => member.identity.cameraId));
  });

  it("deletes only the area by default", () => {
    const request = fixture("delete-area-keeps-members-and-media").request;
    const expected = planFixture("delete-area-keeps-members-and-media");
    expect(expected.commands).toEqual([
      { kind: "delete-scene-area", areaId: request.area.areaId, expectedScopeVersion: request.area.scopeVersion }
    ]);
    expect(expected.inverse).toEqual([
      {
        kind: "restore-scene-area",
        areaId: request.area.areaId,
        scopeVersion: request.area.scopeVersion,
        bounds: request.area.bounds
      }
    ]);
    expectNotReferenced(expected.commands, request.members.instances.map((member) => member.identity.instanceId));
    expectNotReferenced(expected.commands, request.members.cameras.map((member) => member.identity.cameraId));
  });

  it("deletes exactly the fixed eligible set with explicit content deletion and keeps generated media", () => {
    const candidate = fixture("delete-area-with-contents-uses-fixed-eligible-set-and-keeps-media");
    const request = candidate.request;
    const expected = planFixture(candidate.name);
    const deletedInstances = expected.commands
      .filter((command) => command.kind === "delete-instance")
      .map((command) => command.target.instanceId);
    const deletedCameras = expected.commands
      .filter((command) => command.kind === "delete-world-camera")
      .map((command) => command.target.cameraId);

    expect(new Set(deletedInstances)).toEqual(new Set(request.members.instances.map((member) => member.identity.instanceId)));
    expect(new Set(deletedCameras)).toEqual(new Set(request.members.cameras.map((member) => member.identity.cameraId)));
    expect(expected.commands.at(-1)?.kind).toBe("delete-scene-area");
    expect(expected.commands.filter((command) => command.kind === "delete-scene-area")).toHaveLength(1);

    expectNotReferenced(expected.commands, candidate.preservedMediaIds ?? []);
    expectNotReferenced(expected.inverse, candidate.preservedMediaIds ?? []);
  });

  it("never absorbs traversed, partially contained or read-only objects", () => {
    for (const candidate of SCENE_AREA_PLAN_FIXTURES) {
      if (candidate.expected.kind !== "plan") continue;
      expect(candidate.excludedObjectIds?.length).toBeGreaterThan(0);
      expect(candidate.preservedMediaIds?.length).toBeGreaterThan(0);
      expectNotReferenced(candidate.expected.commands, candidate.excludedObjectIds ?? []);
      expectNotReferenced(candidate.expected.inverse, candidate.excludedObjectIds ?? []);
      expectNotReferenced(candidate.expected.commands, candidate.preservedMediaIds ?? []);
      expectNotReferenced(candidate.expected.inverse, candidate.preservedMediaIds ?? []);
    }
  });

  it("classifies every failure fixture by exactly one documented taxonomy rule", () => {
    const failureFixtures = SCENE_AREA_PLAN_FIXTURES.filter(
      (candidate): candidate is SceneAreaPlanFixture & { expected: { kind: "failure"; code: (typeof SCENE_AREA_PLAN_FAILURE_CODES)[number] } } =>
        candidate.expected.kind === "failure"
    );
    expect(failureFixtures.length).toBeGreaterThanOrEqual(SCENE_AREA_PLAN_FAILURE_PRECEDENCE.length);

    const rules = Object.keys(SCENE_AREA_PLAN_FAILURE_RULES) as SceneAreaPlanFailureRuleId[];
    for (const rule of rules) {
      const candidate = failureFixture(rule);
      expect(candidate.rule).toBe(rule);
      const expected = candidate.expected;
      if (expected.kind !== "failure") throw new Error(`${rule} is not a failure fixture`);
      expect(expected.code).toBe(SCENE_AREA_PLAN_FAILURE_RULES[rule].code);
      expect(RULE_PREDICATES[rule](candidate.request), rule).toBe(true);

      const matching = rules.filter((other) => RULE_PREDICATES[other](candidate.request));
      expect(matching, `${rule}: ${matching.join(",")}`).toEqual([rule]);
    }

    const covered = new Set(failureFixtures.map((candidate) => candidate.expected.code));
    for (const code of SCENE_AREA_PLAN_FAILURE_CODES) expect(covered, code).toContain(code);
  });

  it("keeps the operationId retry and redo boundary explicit", () => {
    expect(SCENE_AREA_PLAN_IDEMPOTENCY.conflictingIntent).toBe("operation-conflict");
    expect(SCENE_AREA_PLAN_IDEMPOTENCY.sameIntent).toContain("returns-original-plan");
    expect(SCENE_AREA_PLAN_IDEMPOTENCY.redoBoundary).toContain("without-recomputing");
    expect(SCENE_AREA_PLAN_IDEMPOTENCY.sourceCheck).toContain("frozen-intent");
  });

  it("keeps the plan shell free of media, lease and storage fields", () => {
    const planKeys = [...SCENE_AREA_PLAN_KEYS];
    for (const forbidden of ["media", "mediaIds", "lease", "leases", "epoch", "transaction", "database"]) {
      expect(planKeys).not.toContain(forbidden);
    }

    const candidate = fixture("move-fixed-members-preserve-height-and-relative-pose");
    const expected = planFixture(candidate.name);
    const plan: SceneAreaPlan = {
      contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
      canvasId: candidate.request.canvasId,
      operationId: candidate.request.operationId,
      intent: candidate.request.intent,
      source: { area: candidate.request.area, members: candidate.request.members },
      commands: expected.commands,
      inverse: expected.inverse
    };
    expect(hasOnlyKeys(asRecord(plan), SCENE_AREA_PLAN_KEYS)).toBe(true);
    expect(hasOnlyKeys(asRecord(plan.source), SCENE_AREA_PLAN_SOURCE_KEYS)).toBe(true);
    expect(hasOnlyKeys(asRecord({ ok: true, plan }), SCENE_AREA_PLAN_RESULT_KEYS.ok)).toBe(true);
    expect(
      hasOnlyKeys(asRecord({ ok: false, code: "invalid-input", operationId: plan.operationId }), SCENE_AREA_PLAN_RESULT_KEYS.failure)
    ).toBe(true);
  });
});
