import { describe, expect, it } from "vitest";
import { applyCanvasCommands } from "./command-reducer.js";
import { ContentContributionRegistry } from "./content-contribution.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { isCanvasCommandBatchSatisfied } from "./command-satisfaction.js";
import { decodeEditApplyCommand } from "./edit-command.js";
import { planCanvasEdit } from "./edit-plan.js";

const NOW = "2026-10-30T00:00:00.000Z";
function base() {
  const canvas = createEmptyWoohaa3ServerCanvas("edit", NOW);
  canvas.document.nodes.push({ id: "n", type: "image", position: { x: 0, y: 0 } });
  return canvas;
}
const operation = (from: string, to: string) => ({ kind: "extension.edit" as const, extensionId: "test.edit", nodeId: "n", op: { from, to } });
function registry(expand?: (input: { nodeId: string; op: unknown }) => unknown) {
  const content = new ContentContributionRegistry();
  content.register({ extensionId: "test.edit", edit: {
    expand: expand ?? (input => {
      const op = input.op as { from: string; to: string };
      return { preconditions: [{ kind: "canvas-title-equals", title: op.from }], operations: [{ kind: "canvas-title-set", title: op.to }] };
    }),
    plan: (before, after) => ({ ok: true, preconditions: [],
      forward: { preconditions: [], operations: [operation(before.title ?? "", after.title ?? "")] },
      inverse: { preconditions: [], operations: [operation(after.title ?? "", before.title ?? "")] } })
  } });
  return content;
}

describe("extension.edit protected structural expansion", () => {
  it("decodes opaque owner envelopes and preserves exact undo/redo", () => {
    const content = registry(), canvas = base();
    const command = { type: "edit.apply" as const, preconditions: [], operations: [operation(canvas.title ?? "", "changed")] };
    expect(decodeEditApplyCommand(command)).toEqual(command);
    const changed = applyCanvasCommands(canvas, [command], { content, now: NOW });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(isCanvasCommandBatchSatisfied(changed.canvas, [command], content)).toBe(true);
    expect(isCanvasCommandBatchSatisfied(canvas, [command], content)).toBe(false);
    const undone = applyCanvasCommands(changed.canvas, [{ ...command, operations: [operation("changed", canvas.title ?? "")] }], { content, now: NOW });
    expect(undone.ok && undone.canvas.title).toBe(canvas.title);
    if (!undone.ok) return;
    expect(applyCanvasCommands(undone.canvas, [command], { content, now: NOW })).toMatchObject({ ok: true, canvas: { title: "changed" } });
  });

  it("evaluates owner preconditions before any operation and rejects a stale batch atomically", () => {
    const canvas = base(), content = registry();
    const command = { type: "edit.apply" as const, preconditions: [], operations: [
      { kind: "canvas-title-set" as const, title: "changed" }, operation("stale", "overwritten")
    ] };
    expect(applyCanvasCommands(canvas, [command], { content, now: NOW })).toMatchObject({ ok: false, rejection: { code: "edit-precondition-failed" } });
    expect(canvas.title).not.toBe("changed");
  });

  it("rejects missing owners, forged node ownership, exceptions, recursion and invalid output", () => {
    const canvas = base();
    const command = { type: "edit.apply" as const, preconditions: [], operations: [operation(canvas.title ?? "", "changed")] };
    expect(applyCanvasCommands(canvas, [command], { now: NOW })).toMatchObject({ ok: false, rejection: { code: "content-owner-unavailable" } });
    for (const expand of [() => ({ preconditions: [], operations: command.operations }), () => ({ preconditions: [], operations: [{ kind: "unknown" }] })]) {
      expect(applyCanvasCommands(canvas, [command], { content: registry(expand), now: NOW })).toMatchObject({ ok: false, rejection: { code: "edit-operation-invalid" } });
    }
    const failed = applyCanvasCommands(canvas, [command], { content: registry(() => { throw Error("secret"); }), now: NOW });
    expect(failed).toMatchObject({ ok: false, rejection: { code: "content-codec-failed" } });
    expect(JSON.stringify(failed)).not.toContain("secret");
    canvas.document.nodes[0]!.type = "composite-asset";
    canvas.nodeData.n = { extensionId: "test.other" };
    expect(applyCanvasCommands(canvas, [command], { content: registry(), now: NOW })).toMatchObject({ ok: false, rejection: { code: "content-owner-unavailable" } });
  });

  it("does not expose original command or canvas objects to owner callbacks", () => {
    const canvas = base();
    const command = { type: "edit.apply" as const, preconditions: [], operations: [operation(canvas.title ?? "", "changed")] };
    const content = registry(input => {
      (input.op as { to: string }).to = "mutated";
      return { preconditions: [], operations: [{ kind: "canvas-title-set", title: "changed" }] };
    });
    expect(applyCanvasCommands(canvas, [command], { content, now: NOW }).ok).toBe(true);
    expect(command.operations[0]!.op.to).toBe("changed");
  });

  it("keeps satisfaction callbacks from mutating canonical state or command payloads", () => {
    const canvas = base(), content = new ContentContributionRegistry();
    const payload = { title: "original" };
    content.register({ extensionId: "test.effect", commands: {
      kinds: ["effect"], decode: command => {
        (command.payload as typeof payload).title = "decoded";
        return { ok: true, value: command.payload };
      },
      apply: (_value, current) => ({ ok: true, canvas: current }),
      satisfied: (_value, current) => { current.title = "mutated"; return true; }
    } });
    expect(isCanvasCommandBatchSatisfied(canvas, [{ type: "extension.command", extensionId: "test.effect", kind: "effect", payload }], content)).toBe(true);
    expect(payload.title).toBe("original");
    expect(canvas.title).not.toBe("mutated");
  });

  it("bounds the aggregate expansion and rejects missing payloads", () => {
    const canvas = base();
    const command = { type: "edit.apply" as const, preconditions: [], operations: [operation(canvas.title ?? "", "changed"), operation(canvas.title ?? "", "changed")] };
    const content = registry(() => ({ preconditions: [], operations: Array.from({ length: 200 }, () => ({ kind: "canvas-title-set", title: "changed" })) }));
    expect(applyCanvasCommands(canvas, [command], { content, now: NOW })).toMatchObject({ ok: false, rejection: { code: "edit-operation-invalid" } });
    expect(decodeEditApplyCommand({ ...command, operations: [{ kind: "extension.edit", extensionId: "test.edit", nodeId: "n" }] })).toBeNull();
    for (const op of [undefined, { bad: () => true }, { bad: Number.POSITIVE_INFINITY }]) {
      expect(decodeEditApplyCommand({ ...command, operations: [{ ...operation("", ""), op }] })).toBeNull();
    }
  });

  it("does not duplicate owner structural changes and refuses overlapping mixed plans", () => {
    const canvas = base(), content = new ContentContributionRegistry();
    const node = { id: "created", type: "image", position: { x: 20, y: 20 } };
    content.register({ extensionId: "test.create", commands: {
      kinds: ["create"], decode: () => ({ ok: true, value: null }), satisfied: () => true,
      apply: (_value, current) => {
        const created = applyCanvasCommands(current, [{ type: "node.add", node }], { now: NOW });
        return created.ok ? { ok: true, canvas: created.canvas } : { ok: false, code: created.rejection.code, reason: created.rejection.message };
      }
    }, edit: { plan: () => ({ ok: true, preconditions: [],
      forward: { preconditions: [{ kind: "node-missing", nodeId: node.id }], operations: [{ kind: "node-add", node }] },
      inverse: { preconditions: [{ kind: "node-exists", nodeId: node.id }], operations: [{ kind: "node-remove", nodeIds: [node.id] }] }
    }) } });
    const create = { type: "extension.command" as const, extensionId: "test.create", kind: "create", payload: null };
    const plan = planCanvasEdit(canvas, [create], { content });
    expect(plan, JSON.stringify(plan)).toMatchObject({ ok: true });
    if (plan.ok) expect(plan.forward.operations).toHaveLength(1);
    expect(planCanvasEdit(canvas, [create, { type: "canvas.setTitle", title: "mixed" }], { content })).toMatchObject({ ok: false, reason: "content-edit-forward-mismatch" });
  });

  it("captures extension command changes through owner forward/inverse plans", () => {
    const content = registry(), canvas = base();
    content.register({ extensionId: "test.command", commands: { kinds: ["rename"], decode: () => ({ ok: true, value: null }), satisfied: () => true,
      apply: (_value, current) => ({ ok: true, canvas: { ...current, title: "changed" } }) },
      edit: registry().resolve("test.edit")!.edit });
    const plan = planCanvasEdit(canvas, [{ type: "extension.command", extensionId: "test.command", kind: "rename", payload: null }], { content });
    expect(plan, JSON.stringify(plan)).toMatchObject({ ok: true });
    if (!plan.ok) return;
    const applied = applyCanvasCommands(canvas, [{ type: "edit.apply", ...plan.forward }], { content, now: NOW });
    expect(applied).toMatchObject({ ok: true, canvas: { title: "changed" } });
    if (!applied.ok) return;
    expect(applyCanvasCommands(applied.canvas, [{ type: "edit.apply", ...plan.inverse }], { content, now: NOW })).toMatchObject({ ok: true, canvas: { title: canvas.title } });
  });
});
