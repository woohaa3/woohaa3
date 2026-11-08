import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  decodeWorldCaptureDynamicVersionKey,
  freezeWorldCaptureVideoInput,
  type WorldCaptureDynamicVersionKey,
  type WorldCaptureVideoMediaMetadata
} from "@woohaa3/contracts";

export type RecordedCameraResult = {
  key: WorldCaptureDynamicVersionKey;
  media: WorldCaptureVideoMediaMetadata;
};

/** Only verified result identities are durable; attempts, progress and claims are ephemeral. */
export interface CaptureResultStore {
  read(canvasId: string, cameraId: string): RecordedCameraResult | null;
  write(result: RecordedCameraResult): void;
  forgetCanvas(canvasId: string): void;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** One atomic JSON file per camera, beside the local canvas database in desktop builds. */
export function createFileCaptureResultStore(directory: string): CaptureResultStore {
  const canvasDirectory = (canvasId: string) => path.join(directory, hash(canvasId));
  const filename = (canvasId: string, cameraId: string) => path.join(canvasDirectory(canvasId), `${hash(cameraId)}.json`);
  return {
    read(canvasId, cameraId) {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(readFileSync(filename(canvasId, cameraId), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      if (body?.version !== "world-camera-recording-v1") return null;
      const key = decodeWorldCaptureDynamicVersionKey(body.key);
      if (!key.ok || key.value.canvasId !== canvasId || key.value.cameraId !== cameraId) return null;
      const frozen = freezeWorldCaptureVideoInput(key.value, key.value, body.media as WorldCaptureVideoMediaMetadata);
      return frozen.ok ? { key: key.value, media: frozen.value.media } : null;
    },
    write(result) {
      const { canvasId, cameraId } = result.key;
      const file = filename(canvasId, cameraId);
      mkdirSync(canvasDirectory(canvasId), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ version: "world-camera-recording-v1", ...result }), { mode: 0o600 });
        renameSync(temporary, file);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    forgetCanvas(canvasId) {
      rmSync(canvasDirectory(canvasId), { recursive: true, force: true });
    }
  };
}
