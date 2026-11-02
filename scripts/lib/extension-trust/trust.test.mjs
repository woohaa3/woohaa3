import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { digest, parseTrustJson, signEnvelope, verifyEnvelope } from "./encoding.mjs";
import { rotateRoot, verifyPublisherChain, verifyTrustBundle } from "./verify.mjs";
import { fixture } from "./fixture.mjs";
import { openTrustStore } from "./store.mjs";
import { verifyPackageSignature } from "./verify.mjs";
import { packDirectory, unpackExtensionPackage, verifyExtensionPackage } from "../extension-package.mjs";

const fails = (fn, reason) => assert.throws(fn, error => error.code === "MARKETPLACE_SIGNATURE_INVALID" && error.reason === reason);
const chainInput = f => ({ chain: f.chain, context: f.context, extensionId: "photocraft", filesDigest: "b".repeat(64), now: f.now });

test("strict JSON rejects duplicate keys, escaped aliases, unsafe numbers, invalid Unicode and deep documents", () => {
  for (const text of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}']) fails(() => parseTrustJson(text), "duplicate-key");
  for (const text of ['{"x":1.5}', '[1,]', '{"x":1}false', '[01]', '[-0]', '[9007199254740992]', '"\\ud800"', '['.repeat(30) + '0' + ']'.repeat(30)]) {
    assert.throws(() => parseTrustJson(text));
  }
  const value = parseTrustJson('{"__proto__":{"safe":true},"unicode":"中文😀"}');
  assert.equal(Object.getPrototypeOf(value), null);
  assert.equal(value.unicode, "中文😀");
});

test("threshold verification counts distinct authorized keys only", () => {
  const f = fixture();
  const envelope = signEnvelope(f.root, [f.keys.root.privateKey]);
  const keys = { [f.keys.root.keyId]: f.keys.root.publicKey, [f.keys.root2.keyId]: f.keys.root2.publicKey };
  fails(() => verifyEnvelope(envelope, keys, 2), "signature-threshold");
  envelope.signatures.push(envelope.signatures[0]);
  fails(() => verifyEnvelope(envelope, keys, 2), "duplicate-signature");
});

test("bounded issuer chain validates publisher and exact extension ownership", () => {
  const f = fixture();
  assert.equal(verifyPublisherChain(chainInput(f)).publisherId, "test-publisher");
  fails(() => verifyPublisherChain({ ...chainInput(f), extensionId: "other-extension" }), "issuer-scope");
  fails(() => verifyPublisherChain({ ...chainInput(f), context: structuredClone(f.context) }), "unverified-context");
  fails(() => verifyPublisherChain({ ...chainInput(f), now: f.now + 4000 }), "expired-context");
  assert.throws(() => { f.context.targets.revokedKeys.push(f.keys.publisher.keyId); }, TypeError);
});

test("cross-domain certificate, overlong lease and publisher mismatch are rejected", () => {
  const f = fixture();
  const change = patch => ({ ...f.chain, publisher: signEnvelope({ ...f.publisher.signed, ...patch }, [f.keys.ca.privateKey]) });
  fails(() => verifyPublisherChain({ ...chainInput(f), chain: change({ trustDomain: "another-domain" }) }), "wrong-purpose");
  fails(() => verifyPublisherChain({ ...chainInput(f), chain: change({ expiresAt: f.now + 3700 }) }), "certificate-lifetime");
  fails(() => verifyPublisherChain({ ...chainInput(f), chain: change({ publisherId: "intruder" }) }), "publisher-owner-mismatch");
});

test("revoked issuer, certificate, signing key and content fail independently", () => {
  const f = fixture();
  for (const [field, value] of [["revokedKeys", f.keys.publisher.keyId], ["revokedKeys", f.keys.ca.keyId], ["revokedIssuers", digest(f.issuer.signed)], ["revokedCertificates", digest(f.publisher.signed)], ["deniedFilesDigests", "b".repeat(64)]]) {
    const context = verifyTrustBundle({ ...f.input, bundle: f.bundle({ ...f.targets, [field]: [value] }) });
    fails(() => verifyPublisherChain({ ...chainInput(f), context }), "revoked");
  }
});

test("changing unsigned signature lists cannot change certificate identity or evade revocation", () => {
  const f = fixture();
  const other = fixture();
  const chain = structuredClone(f.chain);
  chain.publisher.signatures.push(signEnvelope(f.publisher.signed, [other.keys.publisher.privateKey]).signatures[0]);
  chain.issuer.signatures.push(signEnvelope(f.issuer.signed, [other.keys.issuer.privateKey]).signatures[0]);
  const evidence = verifyPublisherChain({ ...chainInput(f), chain });
  assert.equal(evidence.certificateId, digest(f.publisher.signed));
  for (const patch of [{ revokedCertificates: [evidence.certificateId] }, { revokedIssuers: [evidence.issuerId] }]) {
    const context = verifyTrustBundle({ ...f.input, bundle: f.bundle({ ...f.targets, ...patch }) });
    fails(() => verifyPublisherChain({ ...chainInput(f), chain, context }), "revoked");
  }
});

test("metadata rejects rollback, equivocation, freeze, wrong digest, role confusion and clock rollback", () => {
  const f = fixture();
  const newer = verifyTrustBundle({ ...f.input, bundle: f.bundle({ ...f.targets, version: 2 }, 2), previousState: f.context.nextState });
  fails(() => verifyTrustBundle({ ...f.input, previousState: newer.nextState }), "metadata-rollback");
  fails(() => verifyTrustBundle({ ...f.input, previousState: f.context.nextState, bundle: f.bundle({ ...f.targets, revokedKeys: [f.keys.publisher.keyId] }) }), "metadata-rollback");
  fails(() => verifyTrustBundle({ ...f.input, now: f.now + 4000 }), "expired-or-future");
  fails(() => verifyTrustBundle({ ...f.input, previousState: f.context.nextState, now: f.now - 301 }), "clock-rollback");
  const broken = structuredClone(f.input.bundle);
  broken.snapshot = signEnvelope({ ...broken.snapshot.signed, targetsDigest: "0".repeat(64) }, [f.keys.snapshot.privateKey]);
  fails(() => verifyTrustBundle({ ...f.input, bundle: broken }), "snapshot-mismatch");
  const swapped = { ...f.input.bundle, timestamp: f.input.bundle.targets };
  fails(() => verifyTrustBundle({ ...f.input, bundle: swapped }), "signature-threshold");
});

test("root update needs old and new threshold and sequential versions", () => {
  const f = fixture();
  const next = { ...f.root, version: 2 };
  fails(() => rotateRoot(f.root, [signEnvelope(next, [f.keys.root.privateKey])], f.now), "signature-threshold");
  const signed = signEnvelope(next, [f.keys.root.privateKey, f.keys.root2.privateKey]);
  assert.equal(rotateRoot(f.root, [signed], f.now).version, 2);
  const gap = signEnvelope({ ...next, version: 3 }, [f.keys.root.privateKey, f.keys.root2.privateKey]);
  fails(() => rotateRoot(f.root, [gap], f.now), "root-version-gap");
  const replacement = { ...next, roles: { ...next.roles, root: { keyIds: [f.keys.ca.keyId], threshold: 1 } } };
  fails(() => rotateRoot(f.root, [signEnvelope(replacement, [f.keys.root.privateKey, f.keys.root2.privateKey])], f.now), "signature-threshold");
});

test("normal leaf key rotation preserves publisher identity", () => {
  const f = fixture();
  const another = fixture();
  const publisher = signEnvelope({ ...f.publisher.signed, publicKey: another.keys.publisher.publicKey, serial: "c".repeat(64) }, [f.keys.ca.privateKey]);
  const evidence = verifyPublisherChain({ ...chainInput(f), chain: { ...f.chain, publisher } });
  assert.equal(evidence.publisherId, "test-publisher");
  assert.equal(evidence.keyId, another.keys.publisher.keyId);
});

test("v2 archive covers assets and certificates; no bare-key or unsigned fallback", t => {
  const f = fixture();
  const dir = mkdtempSync(path.join(tmpdir(), "wxt-trust-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "extension.json"), JSON.stringify({ extensionId: "photocraft", version: "0.1.2" }));
  writeFileSync(path.join(dir, "editor.wasm"), Buffer.from([0, 97, 115, 109]));
  const archive = path.join(dir, "..", path.basename(dir) + ".wxt");
  t.after(() => rmSync(archive, { force: true }));
  const result = packDirectory({ treeDir: dir, outFile: archive, privateKey: f.keys.publisher.privateKey, certificateChain: f.chain });
  assert.equal(result.signature.alg, "ed25519-wxt-v2");
  const target = path.join(dir, "unpacked");
  unpackExtensionPackage({ packagePath: archive, destDir: target });
  const options = { treeDir: target, trustContext: f.context, now: f.now };
  assert.equal(verifyExtensionPackage(options).trust, "certified:test-only:test-publisher");
  fails(() => verifyExtensionPackage({ treeDir: target, allowUnsigned: true, trustedKeys: [{ publicKey: f.keys.publisher.publicKey }] }), "unverified-context");
  writeFileSync(path.join(target, "editor.wasm"), "tampered");
  assert.throws(() => verifyExtensionPackage(options), error => error.code === "MARKETPLACE_DIGEST_MISMATCH");
  rmSync(path.join(target, "SIGNATURE"));
  assert.throws(() => verifyExtensionPackage({ ...options, allowUnsigned: true }), /不能降级/);
});

test("v1 signatures with extra version fields are never silently accepted", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "wxt-downgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "FILES.json"), "[]");
  writeFileSync(path.join(dir, "SIGNATURE"), JSON.stringify({ alg: "ed25519", keyId: "x", sig: "x", schemaVersion: 2 }));
  assert.throws(() => verifyExtensionPackage({ treeDir: dir, allowUnsigned: true }), /格式非法/);
});

test("persisted high-water marks survive reopen and rejected refresh never replaces cache", t => {
  const f = fixture();
  const directory = mkdtempSync(path.join(tmpdir(), "wxt-cache-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { directory, pinnedRoot: f.root, floors: f.floors };
  const store = openTrustStore(config);
  fails(() => store.current(f.now), "missing-trust-cache");
  store.update({ bundle: f.input.bundle, now: f.now });
  const revoked = f.bundle({ ...f.targets, version: 2, revokedKeys: [f.keys.publisher.keyId] }, 2);
  store.update({ bundle: revoked, now: f.now });
  const snapshot = readFileSync(path.join(directory, "trust.json"), "utf8");
  const reopened = openTrustStore(config);
  fails(() => reopened.update({ bundle: f.input.bundle, now: f.now }), "metadata-rollback");
  fails(() => reopened.update({ bundle: f.bundle({ ...f.targets, version: 3 }, 3), now: f.now }), "revocation-removed");
  assert.equal(readFileSync(path.join(directory, "trust.json"), "utf8"), snapshot);
  fails(() => verifyPublisherChain({ ...chainInput(f), context: reopened.current(f.now) }), "revoked");
  fails(() => reopened.current(f.now + 4000), "expired-or-future");
  writeFileSync(path.join(directory, "trust.lock"), "occupied");
  assert.throws(() => reopened.update({ bundle: revoked, now: f.now }), error => error.code === "EEXIST");
  assert.equal(readFileSync(path.join(directory, "trust.json"), "utf8"), snapshot);
});

test("ownership transfer requires a higher generation even with a newer valid snapshot", () => {
  const f = fixture();
  const bundle = f.bundle({ ...f.targets, version: 2, owners: { photocraft: { publisherId: "new-publisher", generation: 1 } } }, 2);
  fails(() => verifyTrustBundle({ ...f.input, bundle, previousState: f.context.nextState }), "ownership-rollback");
});

test("JS consumes the same public certificate/package vectors as Go", t => {
  const vector = JSON.parse(readFileSync(new URL("./testdata/vectors.json", import.meta.url), "utf8"));
  for (const tc of vector.cases) {
    let accepted = true;
    try {
      const now = tc.now ?? vector.now;
      const context = verifyTrustBundle({ pinnedRoot: vector.root, bundle: tc.bundle ?? vector.bundle, floors: vector.floors, now });
      verifyPackageSignature({ envelope: tc.envelope ?? vector.envelope, chain: tc.chain ?? vector.chain, context, extensionId: tc.extensionId ?? vector.extensionId, filesDigest: vector.filesDigest, now });
    } catch { accepted = false; }
    assert.equal(accepted, tc.accepted, tc.name);
  }
  for (const text of vector.invalidJSON) assert.throws(() => parseTrustJson(text));
  const dir = mkdtempSync(path.join(tmpdir(), "wxt-vector-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const packagePath = path.join(dir, "test.wxt");
  writeFileSync(packagePath, Buffer.from(vector.archiveBase64, "base64"));
  const treeDir = path.join(dir, "unpacked");
  unpackExtensionPackage({ packagePath, destDir: treeDir });
  const context = verifyTrustBundle({ pinnedRoot: vector.root, bundle: vector.bundle, floors: vector.floors, now: vector.now });
  assert.equal(verifyExtensionPackage({ treeDir, trustContext: context, now: vector.now }).evidence.publisherId, "test-publisher");
});

test("duplicate signature fields cannot be hidden by JSON parsing", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "wxt-duplicate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "FILES.json"), "[]");
  writeFileSync(path.join(dir, "SIGNATURE"), '{"alg":"ed25519-wxt-v2","alg":"ed25519","keyId":"x","sig":"x"}');
  assert.throws(() => verifyExtensionPackage({ treeDir: dir }), /SIGNATURE 不是合法 JSON/);
});
