import { describe, expect, it } from "vitest";
import {
  ContentContributionRegistry,
  createFilmSetGroupMarker,
  filmSetContentContribution,
  filmSetNodeDataCodec,
  type ContentNodeDataCodec
} from "@woohaa3/contracts";
import { animationDefinitionIdentity } from "./current-state.js";
import { readAnimationHistoryPayload } from "./registration.js";

const marker = createFilmSetGroupMarker();
const data = { filmSetGroup: marker, filmSetContent: { schemaVersion: 4, items: [] } };

function rejectingRegistry(): ContentContributionRegistry {
  const registry = new ContentContributionRegistry();
  const nodeData: ContentNodeDataCodec = {
    ...filmSetNodeDataCodec,
    decode() {
      throw new Error("secret history detail");
    }
  };
  registry.register({ extensionId: "film-set", nodeData });
  return registry;
}

describe("片场组历史读取", () => {
  it("没有 resolver 时仍用内核解码", () => {
    expect(readAnimationHistoryPayload(data)).toEqual({ schemaVersion: 4, filmSetGroup: marker });
    expect(animationDefinitionIdentity(data)).toMatch(/^film-set-group:/);
  });

  it("真实片场 codec 与内核结果一致", () => {
    const registry = new ContentContributionRegistry();
    registry.register(filmSetContentContribution);
    expect(readAnimationHistoryPayload(data, registry)).toEqual(readAnimationHistoryPayload(data));
    expect(animationDefinitionIdentity(data, registry)).toBe(animationDefinitionIdentity(data));
  });

  it("owner 拒绝后不再退回内核", () => {
    const registry = rejectingRegistry();
    expect(readAnimationHistoryPayload(data, registry)).toBeNull();
    expect(animationDefinitionIdentity(data, registry)).toBeNull();
  });
});
