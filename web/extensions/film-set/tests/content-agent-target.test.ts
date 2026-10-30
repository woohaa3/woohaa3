import { describe, expect, it } from "vitest";
import { createFilmSetSnapshot, filmSetAnimationsOf, filmSetClipHash } from "@woohaa3/contracts";
import { filmSetAgentTarget, filmSetAgentTargetVersion } from "../src/state/shared/content/agent-target.js";

function scene() {
  return createFilmSetSnapshot({
    title: "agent target",
    timeline: { duration: 4, loop: false },
    model: { modelScript: "scene.box({id:'part'});", modelScriptVersion: "woohaa-model-js-v2" },
    motionScript: "motion.model.rotate('part', { speed: 1 });",
    modelItemId: "item-1"
  });
}

describe("片场 Agent 目标描述符", () => {
  it("声明 mode、读写工具、事件与提示词，供共享目录消费", () => {
    expect(filmSetAgentTarget.mode).toBe("film-set");
    expect(filmSetAgentTarget.readTools).toEqual(expect.arrayContaining(["get_film_set_clips", "get_film_set_export"]));
    expect(filmSetAgentTarget.writeTools).toEqual(expect.arrayContaining(["submit_film_set", "mutate_film_set_clip", "add_film_set_media"]));
    expect(filmSetAgentTarget.events).toEqual(["film-set"]);
    expect(filmSetAgentTarget.hashArgs).toEqual(["expectedSnapshotHash", "expectedClipHash"]);
    expect(filmSetAgentTarget.prompt?.join("\n")).toContain("submit_film_set");
    expect(filmSetAgentTarget.prompt?.join("\n")).toContain("clipTemplate");
  });

  it("冻结单个 clip 时使用该 clip 的稳定哈希", () => {
    const animation = scene();
    const clip = filmSetAnimationsOf(animation).clips[0]!;
    expect(filmSetAgentTargetVersion({ clipId: clip.id, target: { animation } })).toBe(filmSetClipHash(clip));
  });

  it("整节点目标不覆盖默认哈希，缺失冻结 clip 时稳定拒绝", () => {
    const animation = scene();
    expect(filmSetAgentTargetVersion({ target: { animation } })).toBeNull();
    expect(filmSetAgentTargetVersion({ clipId: "missing", target: { animation } })).toBe("");
    expect(filmSetAgentTargetVersion({ clipId: "missing", target: {} })).toBe("");
  });
});
