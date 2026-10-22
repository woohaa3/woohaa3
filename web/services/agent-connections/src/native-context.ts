import { createHash } from "node:crypto";
import type { AgentAdapterRunInput } from "@woohaa3/contracts";

/** All fields come from the accepted host turn, never a browser-supplied owner. */
export type NativeContext = {
  engineVersion: string;
  configRevision: number;
  credentialEpoch: number;
  conversationId: string;
  targetContext: string;
};

export function nativeContextFor(input: AgentAdapterRunInput, engineVersion: string): NativeContext {
  if (!input.connection) throw new Error("Missing frozen connection binding");
  return {
    engineVersion,
    configRevision: input.connection.configRevision,
    credentialEpoch: input.connection.credentialEpoch,
    conversationId: input.conversationId,
    targetContext: JSON.stringify([
      input.canvasId, input.intent.nodeId ?? null, input.intent.mode ?? null,
      input.intent.cameraId ?? null, input.intent.clipId ?? null, input.intent.itemId ?? null
    ])
  };
}

/** Full digest avoids collisions from truncating encoded owner or directory names. */
export function nativeContextKey(owner: string, connectionId: string, context: NativeContext): string {
  return createHash("sha256").update(JSON.stringify([
    owner, connectionId, context.engineVersion, context.configRevision, context.credentialEpoch,
    context.conversationId, context.targetContext
  ])).digest("hex");
}
