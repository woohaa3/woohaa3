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
  expect(particles()).toHaveLength(8);
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
  for (let index = 0; index < 30; index++) feedback!.handle({ ...event, operationId: `run-${index}` });
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
  advance(200); expect(particles()[0]!.style.transform).toContain("156px");
  advance(600); expect(particles()).toHaveLength(8);
  anchor.mockReturnValue({ x: 300, y: 400, generation: 1 });
  advance(readyAt);
  expect(particles()[0]!.style.transform).toContain("156px");
  const origin = particles()[0]!.style.transform;
  advance(readyAt + EXECUTION_LAUNCH.flyMs / 2); expect(particles()[0]!.style.transform).not.toBe(origin);
  advance(readyAt + EXECUTION_LAUNCH.flyMs); expect(particles()).toHaveLength(8);
  advance(readyAt + EXECUTION_LAUNCH.flyMs + EXECUTION_LAUNCH.settleMs + 1); expect(particles()).toHaveLength(0);
});
it("a never-ready anchor expires within budget and cannot replay a late flight", () => {
  const { event, advance, particles, anchor } = setup();
  anchor.mockReturnValue(null);
  feedback!.handle(event); feedback!.handle({ ...event, phase: "accepted" });
  advance(1499); expect(particles()).toHaveLength(8);
  advance(1501); expect(particles()).toHaveLength(0);
  anchor.mockReturnValue({ x: 300, y: 400, generation: 1 });
  advance(1600); expect(particles()).toHaveLength(0);
  feedback!.handle({ ...event, phase: "accepted" }); expect(particles()).toHaveLength(0);
});
it("an obscured real target uses local feedback instead of flying through its panel", () => {
  const { event, advance, particles } = setup();
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.body });
  feedback!.handle(event); feedback!.handle({ ...event, phase: "accepted" });
  advance(EXECUTION_LAUNCH.riseMs); expect(particles()).toHaveLength(8);
  advance(EXECUTION_LAUNCH.riseMs + EXECUTION_LAUNCH.settleMs + 1); expect(particles()).toHaveLength(0);
});
