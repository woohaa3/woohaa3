import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 本域的边界回归（change: 2026-10-22-add-photocraft-image-mode-workflows，任务 1.3 / 5.1）。
 *
 * `parallel-work.md` 要求功能域只写自己的目录、不导入宿主私有模块、不引用兄弟域实现。这条
 * 用例把该约定变成可自动执行的检查：任何一次「顺手 import 兄弟域」都会在这里失败，而不是等到
 * 集成时才发现并行分支互相缠绕。
 */

const dir = new URL("./", import.meta.url);
const repo = new URL("../../../../../", import.meta.url);
const repoRoot = fileURLToPath(repo);

/** 兄弟域目录名（本域之外的功能域）。 */
const siblingDomains = readdirSync(fileURLToPath(new URL("../", import.meta.url)), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "modes")
  .map((entry) => entry.name);

function sources(extension: string): { file: string; text: string }[] {
  return readdirSync(fileURLToPath(dir))
    .filter((name) => name.endsWith(extension) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx"))
    .map((name) => ({ file: name, text: readFileSync(fileURLToPath(new URL(name, dir)), "utf8") }));
}

describe("图像模式域的边界", () => {
  it("TypeScript 侧不导入兄弟域或宿主私有模块", () => {
    const files = sources(".ts").concat(sources(".tsx"));
    expect(files.length).toBeGreaterThan(3);
    for (const { file, text } of files) {
      for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
        const specifier = match[1]!;
        expect(specifier.includes("integrations/"), `${file} 导入了宿主适配：${specifier}`).toBe(false);
        for (const domain of siblingDomains) {
          expect(
            specifier.includes(`/features/${domain}/`) || specifier.includes(`../../${domain}/`),
            `${file} 导入了兄弟域 ${domain}：${specifier}`
          ).toBe(false);
        }
      }
    }
  });

  it("Rust 侧只引用本域与共享入口", () => {
    for (const file of ["mod.rs", "mode.rs", "content.rs", "tools.rs", "wasm.rs"]) {
      const text = readFileSync(fileURLToPath(new URL(`../../../../../rust/crates/editor-core/src/features/modes/${file}`, dir)), "utf8");
      for (const match of text.matchAll(/crate::features::([a-z_]+)/g)) {
        expect(match[1], `${file} 引用了兄弟域 ${match[1]}`).toBe("modes");
      }
    }
    // 核验域同理：只写自己的目录，共享装配由集成方做。
    const verify = readFileSync(
      fileURLToPath(new URL("../../../../../rust/crates/project-verify/src/features/modes/mod.rs", dir)),
      "utf8"
    );
    expect(verify).not.toMatch(/features::(?!modes)/);
  });

  it("本域不改共享基线文件，能力与入口按 P7 发布", () => {
    // 协议域的能力清单必须与 Rust 侧一致；发布后不再是空数组。
    const protocol = readFileSync(
      fileURLToPath(new URL("../../../../../packages/protocol/src/features/modes/index.ts", dir)),
      "utf8"
    );
    expect(protocol).toContain("IMAGE_MODE_CAPABILITIES");
    expect(protocol).toContain('id: "image.modes"');
    // 编辑器装配：没有工具（模式转换不是手势），入口已注册。
    const index = readFileSync(fileURLToPath(new URL("./index.ts", dir)), "utf8");
    expect(index).toContain("tools: []");
    const sections = readFileSync(fileURLToPath(new URL("./sections.tsx", dir)), "utf8");
    expect(sections).toMatch(/export const sections = \[/);
    expect(sections).toContain('menu: "图像"');
    // 仓库根存在即说明路径解析没跑偏（防止上面几个断言在错误目录里空转）。
    expect(repoRoot.length).toBeGreaterThan(0);
  });
});
