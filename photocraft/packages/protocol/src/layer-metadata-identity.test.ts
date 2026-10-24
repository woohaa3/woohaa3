import {readFileSync} from "node:fs";
import {expect,it} from "vitest";
import {canonicalizeImageProjectContent,imageProjectContentHash,type ImageProjectContent} from "./image-project-content.js";
const cases=JSON.parse(readFileSync(new URL("../../../tests/fixtures/layer-metadata-identity.json",import.meta.url),"utf8")) as {name:string;content:ImageProjectContent;canonical:string|null;hash:string|null}[];
for(const entry of cases) it(`跨语言颜色/链接身份：${entry.name}`,()=>{
  expect(canonicalizeImageProjectContent(entry.content)).toBe(entry.canonical);
  expect(imageProjectContentHash(entry.content)).toBe(entry.hash);
});
