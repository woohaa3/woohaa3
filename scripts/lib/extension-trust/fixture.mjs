// Ephemeral test identities only. No production roots or reusable private keys.
import { generateKeyPairSync } from "node:crypto";
import { digest, fingerprint, signEnvelope } from "./encoding.mjs";
import { verifyTrustBundle } from "./verify.mjs";

export function fixture(now = 1800000000) {
  const key = () => {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    return { privateKey: pair.privateKey, publicKey, keyId: fingerprint(publicKey) };
  };
  const keys = Object.fromEntries(["root", "root2", "issuer", "targets", "snapshot", "timestamp", "ca", "publisher"].map(role => [role, key()]));
  const base = (kind, lifetime = 3600) => ({ schemaVersion: 2, kind, trustDomain: "test-only", version: 1, issuedAt: now - 60, expiresAt: now + lifetime });
  const root = {
    ...base("root"), keys: Object.fromEntries(Object.values(keys).map(k => [k.keyId, k.publicKey])),
    roles: Object.fromEntries(["root", "issuer", "targets", "snapshot", "timestamp"].map(role => [role, { keyIds: role === "root" ? [keys.root.keyId, keys.root2.keyId] : [keys[role].keyId], threshold: role === "root" ? 2 : 1 }]))
  };
  const issuer = signEnvelope({ ...base("issuer"), publicKey: keys.ca.publicKey, extensionIds: ["photocraft"], maxLeafSeconds: 86400, pathLength: 0 }, [keys.issuer.privateKey]);
  const publisher = signEnvelope({ ...base("publisher"), issuerId: digest(issuer.signed), serial: "a".repeat(64), publisherId: "test-publisher", extensionId: "photocraft", publicKey: keys.publisher.publicKey, keyUsage: "package-signing" }, [keys.ca.privateKey]);
  const targets = { ...base("targets"), owners: { photocraft: { publisherId: "test-publisher", generation: 1 } }, revokedKeys: [], revokedCertificates: [], revokedIssuers: [], deniedFilesDigests: [] };
  function bundle(next = targets, version = 1) {
    const targets = signEnvelope(next, [keys.targets.privateKey]);
    const snapshot = signEnvelope({ ...base("snapshot"), version, targetsVersion: next.version, targetsDigest: digest(targets) }, [keys.snapshot.privateKey]);
    const timestamp = signEnvelope({ ...base("timestamp"), version, snapshotVersion: version, snapshotDigest: digest(snapshot) }, [keys.timestamp.privateKey]);
    return { targets, snapshot, timestamp };
  }
  const floors = { root: 1, targets: 1, snapshot: 1, timestamp: 1 };
  const input = { pinnedRoot: root, bundle: bundle(), floors, now };
  return { now, keys, base, root, issuer, publisher, chain: { issuer, publisher }, targets, bundle, floors, input, context: verifyTrustBundle(input) };
}
