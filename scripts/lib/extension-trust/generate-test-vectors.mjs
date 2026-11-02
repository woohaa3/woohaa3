import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { packDirectory } from "../extension-package.mjs";
import { fixture } from "./fixture.mjs";
import { canonical, digest, signEnvelope } from "./encoding.mjs";

// This regenerates public test evidence with ephemeral keys. Private keys are never serialized.
const f = fixture();
const filesDigest = "b".repeat(64);
const payload = { schemaVersion: 2, kind: "package", trustDomain: "test-only", extensionId: "photocraft", filesDigest, certificateId: digest(f.publisher.signed) };
const envelope = signEnvelope(payload, [f.keys.publisher.privateKey]);
const leaf = patch => ({ ...f.chain, publisher: signEnvelope({ ...f.publisher.signed, ...patch }, [f.keys.ca.privateKey]) });
const next = fixture();
const rotated = leaf({ publicKey: next.keys.publisher.publicKey });
const cases = [
  { name: "valid", accepted: true },
  { name: "wrong-extension", extensionId: "other", accepted: false },
  { name: "expired", now: f.now + 4000, accepted: false },
  { name: "wrong-domain", chain: leaf({ trustDomain: "another" }), accepted: false },
  { name: "wrong-owner", chain: leaf({ publisherId: "intruder" }), accepted: false },
  { name: "wrong-issuer", chain: leaf({ issuerId: "0".repeat(64) }), accepted: false },
  { name: "overlong-leaf", chain: leaf({ expiresAt: f.now + 3700 }), accepted: false },
  { name: "null-path-length", chain: { ...f.chain, issuer: signEnvelope({ ...f.issuer.signed, pathLength: null }, [f.keys.issuer.privateKey]) }, accepted: false },
  { name: "bad-package-binding", envelope: signEnvelope({ ...payload, filesDigest: "c".repeat(64) }, [f.keys.publisher.privateKey]), accepted: false },
  { name: "leaf-key-rotation", chain: rotated, envelope: signEnvelope({ ...payload, certificateId: digest(rotated.publisher.signed) }, [next.keys.publisher.privateKey]), accepted: true }
];
for (const [field, value] of [["revokedKeys", f.keys.publisher.keyId], ["revokedKeys", f.keys.ca.keyId], ["revokedIssuers", digest(f.issuer.signed)], ["revokedCertificates", digest(f.publisher.signed)], ["deniedFilesDigests", filesDigest]]) {
  cases.push({ name: `revocation-${field}-${cases.length}`, bundle: f.bundle({ ...f.targets, [field]: [value] }), accepted: false });
}
const invalidJSON = ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"x":1.5}', '[1,]', '{"x":1}false', '[01]', '[-0]', '[9007199254740992]', '"\\ud800"', '"\\udc00"', '['.repeat(30) + '0' + ']'.repeat(30)];
const canonicalJSON = ['{"中文":"😀","<":"&","z":9007199254740991,"a":-1}', '{"\uE000":1,"😀":2}', '{"escaped":"\\ud83d\\ude00"}'].map(text => ({ text, canonical: canonical(JSON.parse(text)) }));
const output = { warning: "TEST ONLY: ephemeral public evidence; not a production root", root: f.root, bundle: f.input.bundle, chain: f.chain, envelope, now: f.now, filesDigest, extensionId: "photocraft", floors: f.floors, cases, invalidJSON, canonicalJSON };
const work = fs.mkdtempSync(path.join(os.tmpdir(), "wxt-vectors-"));
try {
  const tree = path.join(work, "tree");
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, "extension.json"), JSON.stringify({ extensionId: "photocraft", version: "0.1.2" }));
  fs.writeFileSync(path.join(tree, "editor.wasm"), Buffer.from([0, 97, 115, 109]));
  const packed = packDirectory({ treeDir: tree, outFile: path.join(work, "test.wxt"), privateKey: f.keys.publisher.privateKey, certificateChain: f.chain });
  output.archiveBase64 = fs.readFileSync(packed.outFile).toString("base64");
  fs.rmSync(path.join(tree,"CERTIFICATES.json"));
  const legacy=packDirectory({treeDir:tree,outFile:path.join(work,"legacy.wxt"),privateKey:f.keys.publisher.privateKey});
  const archive=fs.readFileSync(legacy.outFile);
  const grant={extensionId:"photocraft",version:"0.1.2",archiveDigest:createHash("sha256").update(archive).digest("hex"),filesDigest:digest(legacy.files),publicKey:f.keys.publisher.publicKey,publisherId:"test-publisher",expiresAt:f.now+600};
  output.legacy={archiveBase64:archive.toString("base64"),bundle:f.bundle({...f.targets,legacy:[grant]})};
  cases.push({name:"legacy-grant-valid",bundle:output.legacy.bundle,accepted:true});
  cases.push({name:"legacy-grant-wildcard",bundle:f.bundle({...f.targets,legacy:[{...grant,version:"*"}]}),accepted:false});
  cases.push({name:"legacy-grant-wrong-owner",bundle:f.bundle({...f.targets,legacy:[{...grant,publisherId:"another"}]}),accepted:false});
} finally { fs.rmSync(work, { recursive: true, force: true }); }
const dir = fileURLToPath(new URL("./testdata/", import.meta.url));
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(`${dir}vectors.json`, JSON.stringify(output, null, 2) + "\n");
