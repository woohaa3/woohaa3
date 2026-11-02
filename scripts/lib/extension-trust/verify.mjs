import { canonical, digest, exact, fingerprint, parseTrustJson, requireTrust, verifyEnvelope } from "./encoding.mjs";

const DAY = 86400;
const MAX_SKEW = 300;
const contexts = new WeakSet();
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HASH = /^[a-f0-9]{64}$/;
const BASE = ["schemaVersion", "kind", "trustDomain", "version", "issuedAt", "expiresAt"];
const ROLES = ["root", "issuer", "targets", "snapshot", "timestamp"];
const POLICY = ["owners", "revokedKeys", "revokedCertificates", "revokedIssuers", "deniedFilesDigests"];
const clone = value => parseTrustJson(canonical(value));

function integer(value, minimum = 1) {
  requireTrust(Number.isSafeInteger(value) && value >= minimum, "invalid-integer");
}
function id(value) { requireTrust(typeof value === "string" && ID.test(value) && value.length <= 128, "invalid-id"); }
function hash(value) { requireTrust(typeof value === "string" && HASH.test(value), "invalid-digest"); }
function ids(values) {
  requireTrust(Array.isArray(values) && values.length > 0 && values.length <= 10000 && new Set(values).size === values.length, "invalid-id-list");
  values.forEach(id);
}
function policyShape(policy) {
  requireTrust(policy.owners && typeof policy.owners === "object" && !Array.isArray(policy.owners) && Object.keys(policy.owners).length <= 10000, "invalid-owners");
  for (const [extensionId, owner] of Object.entries(policy.owners)) {
    id(extensionId); exact(owner, ["publisherId", "generation"]); id(owner.publisherId); integer(owner.generation);
  }
  for (const field of POLICY.slice(1)) {
    requireTrust(Array.isArray(policy[field]) && policy[field].length <= 10000 && new Set(policy[field]).size === policy[field].length, "invalid-revocations");
    policy[field].forEach(hash);
  }
}
function header(signed, kind, domain, now, maxLifetime) {
  requireTrust(signed.schemaVersion === 2 && signed.kind === kind && signed.trustDomain === domain, "wrong-purpose");
  id(domain);
  integer(signed.version); integer(signed.issuedAt, 0); integer(signed.expiresAt);
  requireTrust(signed.expiresAt > signed.issuedAt && signed.expiresAt - signed.issuedAt <= maxLifetime, "invalid-lifetime");
  requireTrust(signed.issuedAt <= now + MAX_SKEW && signed.expiresAt > now, "expired-or-future");
}
function roleKeys(root, role) {
  const policy = root.roles[role];
  exact(policy, ["keyIds", "threshold"]);
  integer(policy.threshold);
  requireTrust(Array.isArray(policy.keyIds) && policy.keyIds.length <= 32 && new Set(policy.keyIds).size === policy.keyIds.length && policy.threshold <= policy.keyIds.length, "invalid-threshold");
  const keys = Object.create(null);
  for (const keyId of policy.keyIds) {
    hash(keyId);
    requireTrust(Object.hasOwn(root.keys, keyId), "unknown-key");
    requireTrust(fingerprint(root.keys[keyId]) === keyId, "key-id-mismatch");
    keys[keyId] = root.keys[keyId];
  }
  return { keys, threshold: policy.threshold };
}
function verifyRole(envelope, root, role) {
  const policy = roleKeys(root, role);
  return verifyEnvelope(envelope, policy.keys, policy.threshold);
}
function rootShape(root, domain, now, checkTime = true) {
  exact(root, [...BASE, "keys", "roles"]);
  header(root, "root", domain, checkTime ? now : root.issuedAt, 3660 * DAY);
  exact(root.roles, ROLES);
  requireTrust(root.keys && typeof root.keys === "object" && !Array.isArray(root.keys) && Object.keys(root.keys).length <= 160, "invalid-key-set");
  for (const role of ROLES) roleKeys(root, role);
  // Issuance and mutable metadata cannot share a signing key.
  const issuerKeys = new Set(root.roles.issuer.keyIds);
  for (const role of ["targets", "snapshot", "timestamp"]) {
    requireTrust(root.roles[role].keyIds.every(key => !issuerKeys.has(key) && !root.roles.root.keyIds.includes(key)), "role-key-reuse");
  }
}

/** Validate sequential root updates against the locally pinned root, never a source-supplied root. */
export function rotateRoot(pinnedRoot, updates, now) {
  let root = clone(pinnedRoot);
  integer(now, 0);
  // An expired old root may authorize renewal, but the final root must be current.
  rootShape(root, root.trustDomain, now, false);
  requireTrust(Array.isArray(updates) && updates.length <= 32, "invalid-root-chain");
  for (const envelope of updates) {
    const next = verifyRole(clone(envelope), root, "root");
    rootShape(next, root.trustDomain, now, false);
    requireTrust(next.version === root.version + 1, "root-version-gap");
    verifyRole(envelope, next, "root");
    root = next;
  }
  rootShape(root, root.trustDomain, now);
  return root;
}

function monotonic(envelope, previous, floor) {
  const version = envelope.signed.version;
  integer(floor, 0);
  requireTrust(version >= floor, "metadata-rollback");
  const record = { version, digest: digest(envelope) };
  if (previous) {
    exact(previous, ["version", "digest"]); integer(previous.version); hash(previous.digest);
    requireTrust(version >= previous.version && (version !== previous.version || record.digest === previous.digest), "metadata-rollback");
  }
  return record;
}

/** The returned context is process-local evidence; callers must persist nextState atomically before use. */
export function verifyTrustBundle({ pinnedRoot, rootUpdates = [], bundle, previousState = null, floors, now = Math.floor(Date.now() / 1000) }) {
  integer(now, 0);
  if (previousState) {
    previousState = clone(previousState);
    exact(previousState, ["trustDomain", "timeFloor", "root", "targets", "snapshot", "timestamp", "policy"]);
    exact(previousState.policy, POLICY);
    policyShape(previousState.policy);
    requireTrust(previousState.trustDomain === pinnedRoot.trustDomain, "wrong-trust-domain");
    integer(previousState.timeFloor, 0);
    requireTrust(now + MAX_SKEW >= previousState.timeFloor, "clock-rollback");
    now = Math.max(now, previousState.timeFloor);
  }
  const root = rotateRoot(pinnedRoot, rootUpdates, now);
  exact(floors, ["root", "targets", "snapshot", "timestamp"]);
  const rootRecord = monotonic({ signed: root }, previousState?.root, floors.root);
  const documents = clone(bundle);
  exact(documents, ["targets", "snapshot", "timestamp"]);
  const nextState = { trustDomain: root.trustDomain, timeFloor: now, root: rootRecord };
  for (const role of ["targets", "snapshot", "timestamp"]) {
    const signed = verifyRole(documents[role], root, role);
    header(signed, role, root.trustDomain, now, DAY);
    nextState[role] = monotonic(documents[role], previousState?.[role], floors[role]);
  }
  const { targets: { signed: targets }, snapshot: { signed: snapshot }, timestamp: { signed: timestamp } } = documents;
  exact(timestamp, [...BASE, "snapshotVersion", "snapshotDigest"]);
  exact(snapshot, [...BASE, "targetsVersion", "targetsDigest"]);
  requireTrust(timestamp.snapshotVersion === snapshot.version && timestamp.snapshotDigest === digest(documents.snapshot), "snapshot-mismatch");
  requireTrust(snapshot.targetsVersion === targets.version && snapshot.targetsDigest === digest(documents.targets), "targets-mismatch");
  exact(targets, [...BASE, ...POLICY, ...(Object.hasOwn(targets, "legacy") ? ["legacy"] : [])]);
  if (Object.hasOwn(targets, "legacy")) validateLegacy(targets.legacy, targets.owners);
  policyShape(targets);
  for (const field of POLICY.slice(1)) {
    requireTrust(!previousState || previousState.policy[field].every(value => targets[field].includes(value)), "revocation-removed");
  }
  for (const [extensionId, prior] of Object.entries(previousState?.policy.owners ?? {})) {
    const owner = targets.owners[extensionId];
    requireTrust(owner && owner.generation >= prior.generation && (owner.publisherId === prior.publisherId || owner.generation > prior.generation), "ownership-rollback");
  }
  nextState.policy = {
    owners: targets.owners, revokedKeys: targets.revokedKeys, revokedCertificates: targets.revokedCertificates,
    revokedIssuers: targets.revokedIssuers, deniedFilesDigests: targets.deniedFilesDigests
  };
  const context = { root, targets, now, nextState, expiresAt: Math.min(root.expiresAt, targets.expiresAt, snapshot.expiresAt, timestamp.expiresAt) };
  function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } }
  freeze(context);
  contexts.add(context);
  return context;
}

export function verifyPublisherChain({ chain, context, extensionId, filesDigest, now = Math.floor(Date.now() / 1000) }) {
  requireTrust(contexts.has(context), "unverified-context");
  integer(now, 0);
  requireTrust(now + MAX_SKEW >= context.now && now < context.expiresAt, "expired-context");
  now = Math.max(now, context.now);
  id(extensionId); hash(filesDigest);
  chain = clone(chain);
  exact(chain, ["issuer", "publisher"]);
  const { root, targets } = context;
  const issuer = verifyRole(chain.issuer, root, "issuer");
  exact(issuer, [...BASE, "publicKey", "extensionIds", "maxLeafSeconds", "pathLength"]);
  header(issuer, "issuer", root.trustDomain, now, 180 * DAY);
  ids(issuer.extensionIds); integer(issuer.maxLeafSeconds);
  requireTrust(issuer.pathLength === 0 && issuer.maxLeafSeconds <= 90 * DAY && issuer.extensionIds.includes(extensionId), "issuer-scope");
  const issuerId = digest(chain.issuer.signed);
  const issuerKeyId = fingerprint(issuer.publicKey);
  const publisher = verifyEnvelope(chain.publisher, { [issuerKeyId]: issuer.publicKey }, 1);
  exact(publisher, [...BASE, "issuerId", "serial", "publisherId", "extensionId", "publicKey", "keyUsage"]);
  header(publisher, "publisher", root.trustDomain, now, issuer.maxLeafSeconds);
  hash(publisher.serial); id(publisher.publisherId);
  requireTrust(publisher.keyUsage === "package-signing" && publisher.issuerId === issuerId && publisher.extensionId === extensionId, "publisher-scope");
  requireTrust(publisher.issuedAt >= issuer.issuedAt && publisher.expiresAt <= issuer.expiresAt, "certificate-lifetime");
  const owner = targets.owners[extensionId];
  requireTrust(owner && owner.publisherId === publisher.publisherId, "publisher-owner-mismatch");
  const keyId = fingerprint(publisher.publicKey);
  const certificateId = digest(chain.publisher.signed);
  requireTrust(!targets.revokedIssuers.includes(issuerId) && !targets.revokedCertificates.includes(certificateId) && !targets.revokedKeys.includes(keyId) && !targets.revokedKeys.includes(issuerKeyId) && !targets.deniedFilesDigests.includes(filesDigest), "revoked");
  return { publicKey: publisher.publicKey, keyId, certificateId, issuerId, publisherId: publisher.publisherId, extensionId, trustDomain: root.trustDomain, generation: owner.generation, metadataVersion: targets.version, filesDigest };
}

export function verifyPackageSignature({ envelope, chain, context, extensionId, filesDigest, now }) {
  const evidence = verifyPublisherChain({ chain, context, extensionId, filesDigest, now });
  const payload = verifyEnvelope(envelope, { [evidence.keyId]: evidence.publicKey }, 1);
  exact(payload, ["schemaVersion", "kind", "trustDomain", "extensionId", "filesDigest", "certificateId"]);
  requireTrust(payload.schemaVersion === 2 && payload.kind === "package" && payload.trustDomain === evidence.trustDomain && payload.extensionId === extensionId && payload.filesDigest === filesDigest && payload.certificateId === evidence.certificateId, "package-binding");
  return evidence;
}

/** Exact-package migration grants are not certificate authorities or reusable key trust. */
export function validateLegacy(entries, owners) {
  requireTrust(Array.isArray(entries) && entries.length <= 1000, "invalid-legacy-grants");
  const seen = new Set();
  for (const entry of entries) {
    exact(entry, ["extensionId", "version", "archiveDigest", "filesDigest", "publicKey", "publisherId", "expiresAt"]);
    id(entry.extensionId); id(entry.publisherId); hash(entry.archiveDigest); hash(entry.filesDigest); fingerprint(entry.publicKey); integer(entry.expiresAt);
    requireTrust(typeof entry.version === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(entry.version), "invalid-legacy-version");
    requireTrust(owners[entry.extensionId]?.publisherId === entry.publisherId && !seen.has(entry.archiveDigest), "invalid-legacy-owner");
    seen.add(entry.archiveDigest);
  }
}
export function legacyGrant({ context, extensionId, version, archiveDigest, filesDigest, now = Math.floor(Date.now()/1000) }) {
  requireTrust(contexts.has(context) && now < context.expiresAt, "unverified-context");
  const entry = (context.targets.legacy ?? []).find(e => e.extensionId === extensionId && e.version === version && e.archiveDigest === archiveDigest && e.filesDigest === filesDigest && e.expiresAt > now);
  requireTrust(entry, "legacy-package-not-authorized");
  const keyId = fingerprint(entry.publicKey);
  requireTrust(!context.targets.revokedKeys.includes(keyId) && !context.targets.deniedFilesDigests.includes(filesDigest), "revoked");
  return entry;
}
