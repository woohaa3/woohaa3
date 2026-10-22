/** Page-owned transient feedback. No state here determines acceptance, success or recovery. */
import "./execution-launch.css";
export const EXECUTION_LAUNCH = { riseMs: 90, flyMs: 300, settleMs: 100, waitMs: 1500, risePx: 44, arcPx: 80, spreadPx: 7, particles: 8, flights: 4, maxParticles: 40 } as const;
export type ExecutionOrigin = { x: number; y: number; token: string };
export type ExecutionLaunchEvent = { nodeId: string; operationId: string; origin: ExecutionOrigin; phase: "started" | "accepted" | "rejected" };
type Flight = { event: ExecutionLaunchEvent; started: number; accepted: number | null; particles: HTMLElement[]; generation?: number;
  localOnly: boolean; flash?: boolean; rejectedAt?: number; flyStarted?: number; center?: { x: number; y: number }; progress: number };

export class ExecutionLaunchFeedback {
  private flights = new Map<string, Flight>();
  private seen = new Set<string>();
  private accepted = new Set<string>();
  private frame: number | null = null;
  private disposed = false;
  constructor(private target: Window, private anchor: (nodeId: string, operationId: string) => { x: number; y: number; generation: number } | null,
    private terminal: (nodeId: string, operationId: string) => boolean = () => false) {
    target.document.addEventListener("visibilitychange", this.visibility);
  }
  private key(event: ExecutionLaunchEvent) { return JSON.stringify([event.nodeId, event.operationId, event.origin.token]); }
  handle = (event: ExecutionLaunchEvent) => {
    if (this.disposed || this.target.document.visibilityState === "hidden") return;
    const key = this.key(event);
    if (event.phase === "rejected") {
      const flight = this.flights.get(key);
      if (flight) flight.rejectedAt = this.target.performance.now();
      return;
    }
    if (event.phase === "accepted") {
      if (this.accepted.has(key)) return;
      this.accepted.add(key);
      const flight = this.flights.get(key);
      if (flight && !flight.localOnly) flight.accepted = this.target.performance.now();
      else if (this.seen.has(key) && !this.terminal(event.nodeId, event.operationId)) {
        const destination = this.anchor(event.nodeId, event.operationId);
        if (destination && this.target.document.elementFromPoint(destination.x, destination.y)?.tagName === "CANVAS") {
          this.remove(key);
          const used = [...this.flights.values()].reduce((sum, item) => sum + item.particles.length, 0);
          if (used < EXECUTION_LAUNCH.maxParticles) {
            const particle = this.target.document.createElement("span");
            particle.className = "execution-launch-particle";
            this.target.document.body.append(particle);
            this.flights.set(key, { event, started: this.target.performance.now(), accepted: null, particles: [particle], localOnly: true, flash: true, progress: 0, generation: destination.generation });
            if (this.frame === null) this.frame = this.target.requestAnimationFrame(this.tick);
          }
        }
      }
      return;
    }
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const used = [...this.flights.values()].reduce((sum, flight) => sum + flight.particles.length, 0);
    const localOnly = [...this.flights.values()].filter(flight => !flight.localOnly).length >= EXECUTION_LAUNCH.flights;
    const count = localOnly ? 1 : EXECUTION_LAUNCH.particles;
    if (used + count > EXECUTION_LAUNCH.maxParticles) return;
    const particles = Array.from({ length: count }, () => {
      const element = this.target.document.createElement("span");
      element.className = "execution-launch-particle";
      this.target.document.body.append(element);
      return element;
    });
    this.flights.set(key, { event, started: this.target.performance.now(), accepted: null, particles, localOnly, progress: 0 });
    if (this.frame === null) this.frame = this.target.requestAnimationFrame(this.tick);
  };
  private tick = (now: number) => {
    this.frame = null;
    for (const [key, flight] of this.flights) {
      const age = now - flight.started;
      if (flight.flash) {
        const point = this.anchor(flight.event.nodeId, flight.event.operationId);
        if (!point || point.generation !== flight.generation || age >= EXECUTION_LAUNCH.settleMs
          || this.target.document.elementFromPoint(point.x, point.y)?.tagName !== "CANVAS") { this.remove(key); continue; }
        const particle = flight.particles[0]!;
        particle.style.transform = `translate3d(${point.x}px, ${point.y}px, 0) scale(${3 - 2 * age / EXECUTION_LAUNCH.settleMs})`;
        particle.style.opacity = String(1 - age / EXECUTION_LAUNCH.settleMs);
        continue;
      }
      const rejecting = flight.rejectedAt === undefined ? null : now - flight.rejectedAt;
      if ((rejecting !== null && rejecting >= EXECUTION_LAUNCH.settleMs) || (flight.localOnly && age >= EXECUTION_LAUNCH.riseMs + EXECUTION_LAUNCH.settleMs)) { this.remove(key); continue; }
      if ((flight.flyStarted === undefined && age >= EXECUTION_LAUNCH.waitMs) || this.terminal(flight.event.nodeId, flight.event.operationId)) { this.remove(key); continue; }
      const destination = flight.accepted === null || flight.localOnly ? null : this.anchor(flight.event.nodeId, flight.event.operationId);
      if (flight.generation !== undefined && !destination) { this.remove(key); continue; }
      if (destination && flight.generation !== undefined && flight.generation !== destination.generation) { this.remove(key); continue; }
      if (destination) flight.generation = destination.generation;
      const top = destination ? this.target.document.elementFromPoint(destination.x, destination.y) : null;
      const visible = destination && top?.tagName === "CANVAS" && age >= EXECUTION_LAUNCH.riseMs;
      // Acceptance can precede the first accepted scene containing this operation's dot.
      // Start the flight clock only when its real, unobscured anchor is available.
      if (visible) flight.flyStarted ??= now;
      const flyAge = flight.flyStarted === undefined ? 0 : now - flight.flyStarted;
      const progress = Math.min(1, flyAge / EXECUTION_LAUNCH.flyMs);
      if (flight.accepted !== null && (flyAge >= EXECUTION_LAUNCH.flyMs + EXECUTION_LAUNCH.settleMs || (destination && !visible && age > EXECUTION_LAUNCH.riseMs + EXECUTION_LAUNCH.settleMs))) { this.remove(key); continue; }
      if (visible) {
        flight.center ??= { x: flight.event.origin.x, y: flight.event.origin.y - EXECUTION_LAUNCH.risePx };
        // Retarget the remaining path from its last position, so moving a node cannot teleport particles.
        const step = flight.progress >= 1 ? 1 : (progress - flight.progress) / (1 - flight.progress);
        flight.center.x += (destination.x - flight.center.x) * step;
        flight.center.y += (destination.y - flight.center.y) * step;
        flight.progress = progress;
      }
      for (let index = 0; index < flight.particles.length; index++) {
        const spread = (index - (flight.particles.length - 1) / 2) * EXECUTION_LAUNCH.spreadPx;
        const origin = flight.event.origin;
        const rise = Math.min(1, age / EXECUTION_LAUNCH.riseMs);
        const x = visible ? flight.center!.x + spread * (1 - progress) : origin.x + spread;
        const y = visible ? flight.center!.y - Math.sin(progress * Math.PI) * (EXECUTION_LAUNCH.arcPx + index * 4) : origin.y - EXECUTION_LAUNCH.risePx * (1 - (1 - rise) ** 3);
        const opacity = rejecting !== null ? 1 - rejecting / EXECUTION_LAUNCH.settleMs
          : flight.localOnly ? 1 - Math.max(0, age - EXECUTION_LAUNCH.riseMs) / EXECUTION_LAUNCH.settleMs
          : flight.accepted === null ? Math.max(0, 1 - Math.max(0, age - EXECUTION_LAUNCH.riseMs) / (EXECUTION_LAUNCH.waitMs - EXECUTION_LAUNCH.riseMs)) : 1 - Math.max(0, flyAge - EXECUTION_LAUNCH.flyMs) / EXECUTION_LAUNCH.settleMs;
        const settle = Math.min(1, Math.max(0, flyAge - EXECUTION_LAUNCH.flyMs) / EXECUTION_LAUNCH.settleMs);
        const scale = visible && progress === 1 ? 1 + Math.sin(settle * Math.PI) * 1.8 : 1.4 - 0.5 * progress;
        flight.particles[index]!.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
        flight.particles[index]!.style.opacity = String(opacity);
      }
    }
    if (this.flights.size) this.frame = this.target.requestAnimationFrame(this.tick);
  };
  private remove(key: string) { for (const particle of this.flights.get(key)?.particles ?? []) particle.remove(); this.flights.delete(key); }
  private visibility = () => { if (this.target.document.visibilityState === "hidden") this.clear(); };
  private clear() { for (const key of this.flights.keys()) this.remove(key); if (this.frame !== null) this.target.cancelAnimationFrame(this.frame); this.frame = null; }
  dispose() { this.disposed = true; this.clear(); this.target.document.removeEventListener("visibilitychange", this.visibility); }
}
