import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { canonicalizeImageProjectContent, imageProjectContentHash } from "./image-project-content.js";

it("matches Rust identity with modes, channels, text styles, paths, animation and variables together", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/integrated-content.json", import.meta.url), "utf8"));
  expect(canonicalizeImageProjectContent(fixture.input)).toBe(fixture.canonical);
  expect(imageProjectContentHash(fixture.input)).toBe(fixture.hash);
  for (const field of ["patternContentHash", "channelsContentHash", "mode", "textStyles", "paths", "workPath", "clippingPath", "animation", "variables"]) {
    const changed = { ...fixture.input };
    delete changed[field];
    expect(imageProjectContentHash(changed), field).not.toBe(fixture.hash);
  }
});
