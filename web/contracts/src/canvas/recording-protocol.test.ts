/**
 * 录制控制协议：TS 投影与 Rust 投影共享同一 fixtures
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 1.3）。
 *
 * `web/contracts/fixtures/recording-protocol/control-messages.json` 由
 * `bevy/src/recording_protocol.rs` 与 `bevy/tests/recording_protocol_fixtures.rs`
 * 共同读取；本测试断言同一批消息在 TS 侧得到同样的结论。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_RESOURCE_CHUNK_BYTES,
  RECORDING_PROTOCOL_ERROR_CODES,
  RECORDING_PROTOCOL_VERSION,
  RECORDING_TERMINAL_STATES,
  RecordingSequenceGuard,
  acceptsResult,
  identitySupersedes,
  isCompleteJobIdentity,
  parseControlMessage,
  parseProtoUint64,
  readJobIdentity,
  validateResourceChunk
} from "./recording-protocol.js";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const fixture = JSON.parse(
  readFileSync(resolve(here, "fixtures", "recording-protocol", "control-messages.json"), "utf8")
) as {
  protocolVersion: string;
  identity: Record<string, unknown>;
  cases: Array<{
    name: string;
    expect: "accepted" | "rejected";
    code?: string;
    message: unknown;
  }>;
};

describe("recording control protocol fixtures", () => {
  it("uses the declared protocol version", () => {
    expect(fixture.protocolVersion).toBe(RECORDING_PROTOCOL_VERSION);
  });

  it("rejects a protocol version that is not the shared constant", () => {
    const result = parseControlMessage(
      JSON.stringify({ protocolVersion: "RECORDING_PROTOCOL_VERSION_9", sequence: "1", capabilityRequest: {} })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(RECORDING_PROTOCOL_ERROR_CODES.versionMismatch);
  });

  for (const testCase of fixture.cases) {
    it(`${testCase.expect}s: ${testCase.name}`, () => {
      const result = parseControlMessage(JSON.stringify(testCase.message));
      if (testCase.expect === "accepted") {
        expect(result.ok, result.ok ? "" : `${result.code}: ${result.message}`).toBe(true);
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe(testCase.code);
      }
    });
  }

  it("returns the payload name and sequence of an accepted message", () => {
    const result = parseControlMessage(
      JSON.stringify({
        protocolVersion: RECORDING_PROTOCOL_VERSION,
        sequence: "42",
        progress: {
          sequence: "42",
          job: fixture.identity,
          state: "RECORDING_JOB_STATE_RENDERING",
          completedFrames: "12"
        }
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payloadName).toBe("progress");
      expect(result.sequence).toBe(42);
      const identity = readJobIdentity(result.payload.job);
      expect(isCompleteJobIdentity(identity)).toBe(true);
      expect(identity?.executionEpoch).toBe(3);
    }
  });

  it("classifies terminal states and accepts only the exact attempt", () => {
    const current = readJobIdentity(fixture.identity)!;
    expect(isCompleteJobIdentity(current)).toBe(true);
    expect(acceptsResult(current, current)).toBe(true);
    const otherAttempt = { ...current, attemptId: "attempt-2" };
    expect(acceptsResult(current, otherAttempt)).toBe(false);
    expect(identitySupersedes(current, otherAttempt)).toBe(true);
    expect(identitySupersedes(current, current)).toBe(false);
    expect(RECORDING_TERMINAL_STATES).toContain("RECORDING_JOB_STATE_SUCCEEDED");
    expect(RECORDING_TERMINAL_STATES).not.toContain("RECORDING_JOB_STATE_COMMITTING");
  });

  it("drops out-of-order and duplicate sequences per attempt", () => {
    const guard = new RecordingSequenceGuard();
    const attempt = { jobId: "job-1", attemptId: "attempt-1" };
    expect(guard.accept(attempt, 1)).toBe(true);
    expect(guard.accept(attempt, 2)).toBe(true);
    expect(guard.accept(attempt, 2)).toBe(false);
    expect(guard.accept(attempt, 1)).toBe(false);
    expect(guard.lastSequence(attempt)).toBe(2);
    expect(guard.accept({ ...attempt, attemptId: "attempt-2" }, 1)).toBe(true);
  });

  it("enforces the 1 MiB chunk budget and contiguous offsets", () => {
    expect(validateResourceChunk(0, MAX_RESOURCE_CHUNK_BYTES, 0)).toEqual({ ok: true });
    const oversized = validateResourceChunk(0, MAX_RESOURCE_CHUNK_BYTES + 1, 0);
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.code).toBe(RECORDING_PROTOCOL_ERROR_CODES.chunkTooLarge);
    const outOfOrder = validateResourceChunk(10, 4, 4);
    expect(outOfOrder.ok).toBe(false);
    if (!outOfOrder.ok) expect(outOfOrder.code).toBe(RECORDING_PROTOCOL_ERROR_CODES.sequenceOutOfOrder);
  });

  it("rejects uint64 values that cannot be represented safely", () => {
    expect(parseProtoUint64("0")).toBe(0);
    expect(parseProtoUint64("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseProtoUint64("9007199254740992")).toBeNull();
    expect(parseProtoUint64(-1)).toBeNull();
    expect(parseProtoUint64("1.5")).toBeNull();
    expect(parseProtoUint64("")).toBeNull();
  });

  it("rejects non-object and malformed messages", () => {
    expect(parseControlMessage("[]").ok).toBe(false);
    expect(parseControlMessage("not json").ok).toBe(false);
    expect(
      parseControlMessage(
        JSON.stringify({ protocolVersion: RECORDING_PROTOCOL_VERSION, sequence: "1" })
      ).ok
    ).toBe(false);
  });
});

it("accepts executor leases while idle and rejects unidentified leases", () => {
  for (const payload of ["leaseHeartbeat", "leaseRenewal"]) {
    expect(parseControlMessage(JSON.stringify({ protocolVersion: RECORDING_PROTOCOL_VERSION, sequence: "1", [payload]: { executorInstanceId: "desktop-1" } })).ok).toBe(true);
    expect(parseControlMessage(JSON.stringify({ protocolVersion: RECORDING_PROTOCOL_VERSION, sequence: "1", [payload]: {} })).ok).toBe(false);
    expect(parseControlMessage(JSON.stringify({ protocolVersion: RECORDING_PROTOCOL_VERSION, sequence: "1", [payload]: { executorInstanceId: "desktop-1", job: {} } })).ok).toBe(false);
  }
});
