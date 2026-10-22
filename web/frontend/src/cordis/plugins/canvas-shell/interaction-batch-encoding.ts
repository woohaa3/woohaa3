/** Bound actual UTF-8 bytes, including repeated event contexts and keepalive's body limit. */
export function encodeInteractionBatch<S>(payload: { samples: S[] } & Record<string, unknown>, closing: boolean) {
  const limit = (closing ? 60 : 120) * 1024;
  const remainder: S[] = [];
  const encoder = new TextEncoder();
  let body = JSON.stringify(payload);
  while (encoder.encode(body).byteLength > limit) {
    if (payload.samples.length <= 1) throw new Error("Performance sample exceeds body budget");
    remainder.unshift(...payload.samples.splice(Math.ceil(payload.samples.length / 2)));
    body = JSON.stringify(payload);
  }
  return { body, remainder };
}
