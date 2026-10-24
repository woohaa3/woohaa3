import {readFileSync} from "node:fs";
import {expect,it} from "vitest";
import {canonicalizeImageProjectContent,imageProjectContentHash,type ImageProjectContent} from "./image-project-content.js";
const cases=JSON.parse(readFileSync(new URL("../../../tests/fixtures/mask-properties-identity.json",import.meta.url),"utf8")) as {name:string;content:ImageProjectContent;canonical:string|null;hash:string|null}[];
for(const entry of cases) it(`跨语言蒙版属性身份：${entry.name}`,()=>{
  expect(canonicalizeImageProjectContent(entry.content)).toBe(entry.canonical);
  expect(imageProjectContentHash(entry.content)).toBe(entry.hash);
});

it("零值符号不改变蒙版身份",()=>{
 const content=structuredClone(cases.find(entry=>entry.name==="both")!.content);
 content.layers[0].mask!.density=0;
 const hash=imageProjectContentHash(content);content.layers[0].mask!.density=-0;
 expect(imageProjectContentHash(content)).toBe(hash);
});
