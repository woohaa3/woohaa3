// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { EXECUTION_LAUNCH, ExecutionLaunchFeedback, type ExecutionLaunchEvent } from "./execution-launch.js";
let feedback: ExecutionLaunchFeedback | undefined;
afterEach(() => { feedback?.dispose(); vi.restoreAllMocks(); document.body.replaceChildren(); });
function setup() {
  let now = 0;
  let callback: FrameRequestCallback | null = null;
  vi.spyOn(window.performance, "now").mockImplementation(() => now);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(next => { callback = next; return 1; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => { callback = null; });
  const canvas = document.createElement("canvas"); document.body.append(canvas);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => canvas });
  const anchor = vi.fn(() => ({ x: 300, y: 400, generation: 1 } as { x: number; y: number; generation: number } | null));
  const terminal = vi.fn(() => false);
  feedback = new ExecutionLaunchFeedback(window, anchor, terminal);
  const event: ExecutionLaunchEvent = { nodeId: "n", operationId: "run", origin: { x: 100, y: 200, token: "intent" }, phase: "started" };
  return { event, anchor, terminal, cancel, advance: (time: number) => { now = time; const next = callback; callback = null; next?.(time); }, particles: () => [...document.querySelectorAll<HTMLElement>(".execution-launch-particle")] };
}
it("launches once, waits for acceptance and follows the same moving destination", () => {
  const { event, advance, particles, anchor } = setup();
  feedback!.handle(event); feedback!.handle(event);
  expect(particles()).toHaveLength(EXECUTION_LAUNCH.particles);
  advance(100); expect(anchor).not.toHaveBeenCalled();
  feedback!.handle({ ...event, phase: "accepted" });
  advance(400); const before = particles()[0]!.style.transform;
  anchor.mockReturnValue({ x: 500, y: 600, generation: 1 });
  advance(500); expect(particles()[0]!.style.transform).not.toBe(before);
  advance(1100); expect(particles()).toHaveLength(0);
});
it("slow acceptance, rejection and fast terminal never keep a false running animation", () => {
  const { event, advance, particles, terminal } = setup();
  feedback!.handle(event); advance(1501);
  feedback!.handle({ ...event, phase: "accepted" }); expect(particles()).toHaveLength(1);
  advance(1652); expect(particles()).toHaveLength(0);
  feedback!.handle({ ...event, operationId: "rejected" });
  feedback!.handle({ ...event, operationId: "rejected", phase: "rejected" });
  advance(1803); expect(particles()).toHaveLength(0);
  feedback!.handle({ ...event, operationId: "fast" }); terminal.mockReturnValue(true);
  advance(1810); expect(particles()).toHaveLength(0);
});
it("bounds batch particles and clears them on hidden, generation change and disposal", () => {
  const { event, advance, particles, anchor, cancel } = setup();
  for (let index = 0; index < 50; index++) feedback!.handle({ ...event, operationId: `run-${index}` });
  expect(particles()).toHaveLength(40);
  for (let index = 0; index < 4; index++) feedback!.handle({ ...event, operationId: `run-${index}`, phase: "accepted" });
  advance(200); anchor.mockReturnValue({ x: 300, y: 400, generation: 2 });
  advance(250); expect(particles()).toHaveLength(0);
  advance(301); expect(particles()).toHaveLength(0);
  feedback!.handle({ ...event, operationId: "hidden" });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange")); expect(particles()).toHaveLength(0); expect(cancel).toHaveBeenCalled();
  feedback!.dispose(); expect(particles()).toHaveLength(0);
});
it.each([700, 1400])("a cold first scene can supply its anchor at %dms without skipping or shortening the flight", readyAt => {
  const { event, advance, particles, anchor } = setup();
  anchor.mockReturnValue(null);
  feedback!.handle(event); feedback!.handle({ ...event, phase: "accepted" });
  advance(200); expect(particles()[0]!.style.transform).toContain("200px");
  advance(600); expect(particles()).toHaveLength(EXECUTION_LAUNCH.particles);
  anchor.mockReturnValue({ x: 700, y: 400, generation: 1 });
  advance(readyAt);
  expect(particles()[0]!.style.transform).toContain("200px");
  const origin = particles()[0]!.style.transform;
  advance(readyAt + EXECUTION_LAUNCH.flyMs / 2); expect(particles()[0]!.style.transform).not.toBe(origin);
  advance(readyAt + EXECUTION_LAUNCH.flyMs); expect(particles()).toHaveLength(EXECUTION_LAUNCH.particles);
  advance(readyAt + EXECUTION_LAUNCH.flyMs + EXECUTION_LAUNCH.settleMs + 1); expect(particles()).toHaveLength(0);
});
it("a never-ready anchor expires within budget and cannot replay a late flight", () => {
  const { event, advance, particles, anchor } = setup();
  anchor.mockReturnValue(null);
  feedback!.handle(event); feedback!.handle({ ...event, phase: "accepted" });
  advance(1499); expect(particles()).toHaveLength(EXECUTION_LAUNCH.particles);
  advance(1501); expect(particles()).toHaveLength(0);
  anchor.mockReturnValue({ x: 300, y: 400, generation: 1 });
  advance(1600); expect(particles()).toHaveLength(0);
  feedback!.handle({ ...event, phase: "accepted" }); expect(particles()).toHaveLength(0);
});
it("an obscured real target uses local feedback instead of flying through its panel", () => {
  const { event, advance, particles } = setup();
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.body });
  feedback!.handle(event); feedback!.handle({ ...event, phase: "accepted" });
  advance(EXECUTION_LAUNCH.riseMs); expect(particles()).toHaveLength(EXECUTION_LAUNCH.particles);
  advance(EXECUTION_LAUNCH.riseMs + EXECUTION_LAUNCH.settleMs + 1); expect(particles()).toHaveLength(0);
});

it.each([8, 80, 160])("a nearby dot %dpx away receives a short, shallow handoff", distance => {
  const { event, advance, particles, anchor } = setup();
  anchor.mockReturnValue({ x: event.origin.x + distance, y: 200, generation: 1 });
  feedback!.handle(event);
  expect(particles()[0]!.style.transform).toContain("100px, 200px");
  feedback!.handle({ ...event, phase: "accepted" });
  advance(EXECUTION_LAUNCH.riseMs);
  advance(EXECUTION_LAUNCH.riseMs + 60);
  for (const particle of particles()) {
    const [, x, y] = particle.style.transform.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px/)!.map(Number);
    expect(x).toBeGreaterThanOrEqual(event.origin.x - 3);
    expect(x).toBeLessThanOrEqual(event.origin.x + distance + 3);
    expect(y).toBeGreaterThanOrEqual(200 - Math.min(24, distance * 0.2));
    expect(y).toBeLessThanOrEqual(200);
  }
  advance(EXECUTION_LAUNCH.riseMs + 120);
  expect(particles()[0]!.style.transform).toContain(`${event.origin.x + distance}px, 200px`);
  advance(EXECUTION_LAUNCH.riseMs + 120 + EXECUTION_LAUNCH.settleMs + 1);
  expect(particles()).toHaveLength(0);
});

it("starts with a button-sized light and gradually turns yellow while converging into one dot", () => {
  const { event, advance, particles, anchor } = setup();
  event.origin.surface = { width: 112, height: 36, radius: 8, color: "rgb(22, 132, 108)" };
  anchor.mockReturnValue({ x: 180, y: 200, generation: 1 });
  feedback!.handle(event);
  expect(particles()).toHaveLength(1);
  const light = particles()[0]!;
  expect(light.style.width).toBe("112px");
  expect(light.style.height).toBe("36px");
  expect(light.style.borderRadius).toBe("8px");
  expect(light.style.transform).toBe("translate3d(100px, 200px, 0) translate(-50%, -50%)");
  expect(light.style.getPropertyValue("--execution-launch-source")).toBe("rgb(22, 132, 108)");
  expect(light.style.getPropertyValue("--execution-launch-yellow")).toBe("0%");
  advance(EXECUTION_LAUNCH.riseMs);
  expect(light.style.transform).toContain("scale(1, 1)");
  const firstYellow = Number.parseFloat(light.style.getPropertyValue("--execution-launch-yellow"));
  feedback!.handle({ ...event, phase: "accepted" });
  advance(100);
  advance(160);
  const [, scaleX, scaleY] = light.style.transform.match(/scale\(([-\d.]+), ([-\d.]+)\)/)!.map(Number);
  expect(scaleX! * 112).toBeGreaterThan(4);
  expect(scaleX! * 112).toBeLessThan(112);
  expect(scaleY! * 36).toBeGreaterThan(4);
  expect(scaleY! * 36).toBeLessThan(36);
  const nextYellow = Number.parseFloat(light.style.getPropertyValue("--execution-launch-yellow"));
  expect(nextYellow).toBeGreaterThan(firstYellow);
  expect(nextYellow).toBeLessThan(100);
  advance(220);
  const [, finalX, finalY] = light.style.transform.match(/scale\(([-\d.]+), ([-\d.]+)\)/)!.map(Number);
  expect(finalX! * 112).toBeCloseTo(4);
  expect(finalY! * 36).toBeCloseTo(4);
  expect(light.style.getPropertyValue("--execution-launch-yellow")).toBe("100%");
  expect(light.style.transform).toContain("180px, 200px");
  advance(321);
  expect(particles()).toHaveLength(0);
});

it("keeps a longer handoff for distant batch targets", () => {
  const { event, advance, particles, anchor } = setup();
  anchor.mockReturnValue({ x: 900, y: 192, generation: 1 });
  feedback!.handle(event);
  feedback!.handle({ ...event, phase: "accepted" });
  advance(EXECUTION_LAUNCH.riseMs);
  advance(EXECUTION_LAUNCH.riseMs + 120 + EXECUTION_LAUNCH.settleMs + 1);
  expect(particles()).toHaveLength(EXECUTION_LAUNCH.particles);
  expect(particles()[0]!.style.transform).not.toContain("900px, 192px");
  advance(EXECUTION_LAUNCH.riseMs + EXECUTION_LAUNCH.flyMs);
  expect(particles()[0]!.style.transform).toContain("900px, 192px");
  advance(EXECUTION_LAUNCH.riseMs + EXECUTION_LAUNCH.flyMs + EXECUTION_LAUNCH.settleMs + 1);
  expect(particles()).toHaveLength(0);
});
