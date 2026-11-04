/** One pending capture/ack, with identity-aware timeout recovery. */
export class FrameChannel {
  busy = false;
  pending = null;
  sequence = 0;
  lastAt = -Infinity;
  paused = false;
  canCapture(now, interacting) {
    if (this.pending && now - this.pending.at >= 200) this.pending = null;
    return !this.paused && !this.busy && !this.pending && now - this.lastAt >= (interacting ? 1000 / 30 : 100);
  }
  start(now) { this.busy = true; this.lastAt = now; }
  sent(now) { this.busy = false; const id = ++this.sequence; this.pending = { id, at: now }; return id; }
  ack(id) { if (this.pending?.id === id) this.pending = null; }
}

export function captureGeometry(canvas, rect) {
  const kx = canvas.width / canvas.clientWidth, ky = canvas.height / canvas.clientHeight;
  const x = Math.max(0, Math.round(rect[0] * kx)), y = Math.max(0, Math.round(rect[1] * ky));
  const width = Math.min(canvas.width - x, Math.round(rect[2] * kx));
  const height = Math.min(canvas.height - y, Math.round(rect[3] * ky));
  if (!(width > 0 && height > 0)) return null;
  const scale = Math.min(1, 2048 / Math.max(width, height));
  return { x, y, width, height, outWidth: Math.max(1, Math.round(width * scale)), outHeight: Math.max(1, Math.round(height * scale)) };
}
