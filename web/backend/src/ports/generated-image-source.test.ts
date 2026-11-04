/**
 * 生图产物路径与文件校验（change: 2026-11-03-add-codex-image-import，D5）。
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveGeneratedImage } from "./generated-image-source.js";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

let root: string;
let codexHome: string;
let imagesDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codex-image-"));
  codexHome = path.join(root, "codex");
  imagesDir = path.join(codexHome, "generated_images", "session-1");
  mkdirSync(imagesDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeImage(name: string, header: Buffer, padding = 32): string {
  const file = path.join(imagesDir, name);
  writeFileSync(file, Buffer.concat([header, Buffer.alloc(padding)]));
  return file;
}

describe("resolveGeneratedImage", () => {
  it("接受 generated_images 下的 PNG", () => {
    const file = writeImage("a.png", PNG_HEADER);
    expect(resolveGeneratedImage(file, { codexHome })).toMatchObject({ ok: true, contentType: "image/png" });
  });

  it("接受 generated_images 下的 JPEG", () => {
    const file = writeImage("a.jpg", JPEG_HEADER);
    expect(resolveGeneratedImage(file, { codexHome })).toMatchObject({ ok: true, contentType: "image/jpeg" });
  });

  it("拒绝 ../ 逃逸到 generated_images 之外", () => {
    const outside = path.join(root, "secret.png");
    writeFileSync(outside, Buffer.concat([PNG_HEADER, Buffer.alloc(16)]));
    const escaping = path.join(imagesDir, "..", "..", "..", "secret.png");
    expect(resolveGeneratedImage(escaping, { codexHome })).toMatchObject({ ok: false, code: "path-outside-generated-images" });
  });

  it("拒绝绝对路径越界", () => {
    expect(resolveGeneratedImage("/etc/passwd", { codexHome })).toMatchObject({ ok: false, code: "path-outside-generated-images" });
  });

  it("拒绝符号链接", () => {
    const target = writeImage("real.png", PNG_HEADER);
    const link = path.join(imagesDir, "link.png");
    symlinkSync(target, link);
    expect(resolveGeneratedImage(link, { codexHome })).toMatchObject({ ok: false, code: "not-regular-file" });
  });

  it("拒绝非图片魔数", () => {
    const file = path.join(imagesDir, "notes.png");
    writeFileSync(file, Buffer.from("this is definitely not an image"));
    expect(resolveGeneratedImage(file, { codexHome })).toMatchObject({ ok: false, code: "not-an-image" });
  });

  it("拒绝超过大小上限的文件", () => {
    const file = path.join(imagesDir, "huge.png");
    writeFileSync(file, PNG_HEADER);
    truncateSync(file, 40 * 1024 * 1024);
    expect(resolveGeneratedImage(file, { codexHome })).toMatchObject({ ok: false, code: "too-large" });
  });

  it("拒绝不存在的文件", () => {
    expect(resolveGeneratedImage(path.join(imagesDir, "missing.png"), { codexHome })).toMatchObject({ ok: false, code: "not-found" });
  });
});
