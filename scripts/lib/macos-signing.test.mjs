import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ADHOC_IDENTITY,
  assertUnambiguousIdentity,
  describeMacSigning,
  findMachOFiles,
  isMachO,
  notarizationCredentials,
  notarizationGap,
  parseCodeSigningIdentities,
  resolveMacSigning
} from "./macos-signing.mjs";

const FP = "c2f2c1beb1e965cc1ecf5235af2879aa737e34dd";
const OLD = "cb15702edcf730477ac625426dd53f17dda888b0";

function machoHeader() {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(0xcffaedfe, 0); // Mach-O 64 位小端
  return buffer;
}

test("识别 Mach-O：仅看魔数，不整文件读", () => {
  const header = machoHeader();
  assert.equal(isMachO("/x", () => header), true);
  const fat = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
  assert.equal(isMachO("/x", () => fat), true);
  assert.equal(isMachO("/x", () => Buffer.from("#!/bin/sh\n")), false);
  assert.equal(isMachO("/x", () => Buffer.alloc(2)), false);
  assert.equal(
    isMachO("/x", () => {
      throw new Error("ENOENT");
    }),
    false
  );
});

test("递归收集 Mach-O，跳过树外链接与重复 inode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "macos-sign-"));
  try {
    const host = path.join(root, "host");
    fs.mkdirSync(path.join(host, "packages/addon/prebuilt"), { recursive: true });
    fs.mkdirSync(path.join(host, "packages/text"), { recursive: true });
    fs.writeFileSync(path.join(host, "packages/addon/prebuilt/x.node"), machoHeader());
    fs.writeFileSync(path.join(host, "packages/text/index.js"), "export const a = 1");
    fs.writeFileSync(path.join(root, "outside.node"), machoHeader());
    // pnpm 风格：依赖边是指向树内的相对链接，要跟进去但只报一次
    fs.symlinkSync(path.join(host, "packages/addon"), path.join(host, "linked-addon"));
    fs.symlinkSync(path.join(root, "outside.node"), path.join(host, "escape.node"));

    const found = findMachOFiles(host);
    assert.deepEqual(found, [fs.realpathSync(path.join(host, "packages/addon/prebuilt/x.node"))]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("解析 find-identity 输出", () => {
  const output = `  1) ${OLD.toUpperCase()} "Developer ID Application: HAO YANG (NYZ2G9L287)"
  2) ${FP.toUpperCase()} "Developer ID Application: HAO YANG (NYZ2G9L287)"
  3) 5997F526A296554D163BE4A75D1CAC2B87571E6E "Apple Development: HAO YANG (PHPC5LPQZF)"
     3 valid identities found`;
  const identities = parseCodeSigningIdentities(output);
  assert.equal(identities.length, 3);
  assert.equal(identities[1].fingerprint, FP);
  assert.match(identities[2].name, /Apple Development/);
});

test("同名证书必须用指纹，否则提前失败而不是等 tauri 报 ambiguous", () => {
  const identities = parseCodeSigningIdentities(
    `  1) ${OLD} "Developer ID Application: HAO YANG (NYZ2G9L287)"
  2) ${FP} "Developer ID Application: HAO YANG (NYZ2G9L287)"`
  );
  assert.throws(() => assertUnambiguousIdentity("Developer ID Application: HAO YANG (NYZ2G9L287)", identities), /匹配到 2 张证书/);
  const byFingerprint = assertUnambiguousIdentity(FP.toUpperCase(), identities);
  assert.equal(byFingerprint.fingerprint, FP);
  assert.equal(byFingerprint.adhoc, false);
  assert.equal(assertUnambiguousIdentity("-", identities).adhoc, true);
  assert.equal(assertUnambiguousIdentity("", identities).adhoc, true);
  assert.throws(() => assertUnambiguousIdentity("0123456789abcdef0123456789abcdef01234567", identities), /找不到签名身份/);
  assert.throws(() => assertUnambiguousIdentity("No Such Cert", identities), /找不到签名身份/);
});

test("ad-hoc 身份不做公证", () => {
  const signing = resolveMacSigning({ identity: ADHOC_IDENTITY, notarization: { mode: "api-key" } });
  assert.equal(signing.adhoc, true);
  assert.equal(signing.notarization, null);
  assert.match(describeMacSigning(signing), /ad-hoc/);
  assert.match(notarizationGap(signing), /ad-hoc/);
});

test("公证凭据：两种模式互斥，且缺项要指名", () => {
  const keyPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "notary-")), "AuthKey.p8");
  fs.writeFileSync(keyPath, "test-key-placeholder");
  try {
    assert.equal(notarizationCredentials({}), null);
    assert.deepEqual(
      notarizationCredentials({ APPLE_API_KEY: "ABC123", APPLE_API_ISSUER: "issuer-uuid", APPLE_API_KEY_PATH: keyPath }),
      { mode: "api-key", keyId: "ABC123", issuer: "issuer-uuid" }
    );
    // 返回值不得带出密码
    const byId = notarizationCredentials({ APPLE_ID: "a@b.c", APPLE_PASSWORD: "secret", APPLE_TEAM_ID: "NYZ2G9L287" });
    assert.equal(byId.mode, "apple-id");
    assert.equal(JSON.stringify(byId).includes("secret"), false);

    assert.throws(() => notarizationCredentials({ APPLE_API_KEY: "K", APPLE_ID: "a@b.c" }), /只能二选一/);
    assert.throws(() => notarizationCredentials({ APPLE_API_KEY: "K" }), /缺少：APPLE_API_ISSUER \/ APPLE_API_KEY_PATH/);
    assert.throws(() => notarizationCredentials({ APPLE_ID: "a@b.c", APPLE_PASSWORD: "p" }), /缺少：APPLE_TEAM_ID/);
    assert.throws(
      () => notarizationCredentials({ APPLE_API_KEY: "K", APPLE_API_ISSUER: "i", APPLE_API_KEY_PATH: "/definitely/missing.p8" }),
      /文件不存在/
    );
  } finally {
    fs.rmSync(path.dirname(keyPath), { recursive: true, force: true });
  }
});

test("已 Developer ID 签名但缺公证要如实记成缺口", () => {
  const identities = [{ fingerprint: FP, name: "Developer ID Application: HAO YANG (NYZ2G9L287)" }];
  const signing = resolveMacSigning({ identity: FP, notarization: null, identities });
  assert.equal(signing.adhoc, false);
  assert.match(describeMacSigning(signing), /公证=关闭/);
  assert.match(notarizationGap(signing), /Gatekeeper 仍会拦截/);
  assert.equal(notarizationGap({ ...signing, notarization: { mode: "api-key" } }), null);
});
