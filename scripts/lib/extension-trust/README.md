# Extension trust v2 primitives

Status: integrated into managed installation, activation and rollback. Production roots
must be supplied explicitly; test fixtures are never defaults. The client has no
remote trust RPC dependency and requires neither a running server nor an account.

## Offline initialization and distribution

The pinned deployment config is `{schemaVersion:2, domains:[{root, floors,
extensionIds, metadataUrl?, bootstrap?}]}`. `root` and version `floors` are distributed
with the application by its trusted release channel, never discovered from a package.
`bootstrap` is a public signed document `{bundle, rootUpdates}`; `rootUpdates` contains
the complete ordered transition history from the pinned root. `metadataUrl` is optional
and may point to HTTPS static hosting/CDN rather than an application server.

With no URL, no network request is made. A fresh bootstrap initializes an empty cache
on first verification. It never overwrites a newer cache. Alternatively, import a signed
metadata file before installing (use the same config and managed directory as the host):

```sh
WOOHAA3_EXTENSION_TRUST_CONFIG=/path/to/pinned-config.json \
  node scripts/import-extension-trust.mjs /path/to/managed-root domain /path/to/trust.json
```

For a release desktop use its bundled `extension-trust.json`, not an independently
chosen root file. The CLI only updates public metadata, not the host's trust anchors.
Imports, bundled initialization and HTTPS refresh use the same signature, domain,
root-transition, lifetime, permanent-revocation and persistent antirollback checks.
An imported file cannot add a new root/domain. Export the public JSON from the optional
server's `/marketplace/trust.json`, mirror it, or transport it on removable media.
No admin RPC bindings are needed by the client.

Expired metadata cannot authorize new installations or fresh rollback. Previously
verified installations may run using historical receipts and latest known revocations.
Offline operation does not promise instantaneous discovery of new revocations; transfer
fresh signed metadata periodically. Shipping an old bootstrap cannot extend its lifetime.

## Wire contract

UTF-8 JSON; no duplicate keys (including escaped aliases), unpaired surrogates or
non-safe-integer numbers; maximum nesting 24. Unknown signed fields are rejected.
Control documents are capped at 1 MiB, SIGNATURE at 64 KiB, FILES at 32 MiB.
Canonical encoding sorts keys by UTF-16 code units, matching existing JS/Go package
encoding. This is a restricted application protocol, not TUF or X.509 compliance.

An envelope is `{ signed, signatures: [{ keyId, sig }] }`. Ed25519 signing bytes are
UTF-8 `woohaa.extension-trust.v2` + NUL + canonical JSON of `signed`. `keyId` is full
SHA-256 of canonical Ed25519 SPKI DER; public keys and signatures use canonical base64.
Duplicate keys cannot count towards a signature threshold more than once.

Headers contain `schemaVersion: 2`, `kind`, `trustDomain`, positive `version`, and
integer Unix-second `issuedAt` / exclusive `expiresAt`. Additional fields:

| Kind | Fields |
| --- | --- |
| root | `keys`, `roles` |
| issuer | `publicKey`, `extensionIds`, `maxLeafSeconds`, `pathLength: 0` |
| publisher | `issuerId`, `serial`, `publisherId`, `extensionId`, `publicKey`, `keyUsage: package-signing` |
| targets | `owners`, `revokedKeys`, `revokedCertificates`, `revokedIssuers`, `deniedFilesDigests` |
| snapshot | `targetsVersion`, `targetsDigest` |
| timestamp | `snapshotVersion`, `snapshotDigest` |

Root roles are exactly `root`, `issuer`, `targets`, `snapshot`, `timestamp`, each with
`keyIds` and `threshold`. The `issuer` role signs scope grants and belongs to offline
root administration, **not** the online issuing key inside the grant. Root/issuer
authority keys cannot double as mutable metadata keys. Production thresholds and
custodians must be configured separately; fixtures are not defaults.

Issuer and certificate IDs hash their **signed payload**, not their envelope: adding
or reordering unsigned signature entries must not evade revocation. Metadata digest
links hash complete canonical envelopes to pin exact published bytes. Revocations
contain full hashes; deniedFilesDigests addresses canonical FILES, not archive bytes.
Owners map exact extension IDs to publisherId/generation. Observed revocations cannot
disappear; publisher transfers require higher generations. Owner rows cannot be
deleted to erase previously observed history.

Hard lifetime ceilings: root 3660 days, issuer 180 days, leaf at most its issuer's
grant and 90 days, metadata 24 hours. Not-before skew is 300 seconds; expiry has no
grace. Leaf validity must fit inside the issuer lease. Expiry affects new verification;
this library does not stop running extensions.

## Packages

`CERTIFICATES.json` contains `{ issuer: envelope, publisher: envelope }`, covered by
FILES. SIGNATURE is `{ alg: "ed25519-wxt-v2", envelope }`. Its signed payload has
exactly `schemaVersion: 2`, `kind: package`, `trustDomain`, `extensionId`, `filesDigest`
(canonical FILES SHA-256 without prefix), and `certificateId`.

The separate algorithm discriminator makes old readers reject v2 even when unsigned
local packages are allowed. Certificates with v1/missing signatures are rejected.
Missing/invalid contexts never fall back to trustedKeys. Other legacy v1 behavior
remains until an explicit migration policy is deployed.

The packer accepts `--certificate-chain <chain.json>` with `--key`. It checks key and
extension matching but does **not** certify trust or freshness; receivers must verify.
Do not publish v2 artifacts to existing users before the host/service gates are ready.

## Ownership and integration

- `encoding.mjs`: strict parsing, canonical signing and threshold verification.
- `verify.mjs`: root transitions, metadata binding, ownership, scope, validity and
  revocation. Contexts are frozen, process-local validation results, not source DTOs.
- `store.mjs`: single-writer fsync/rename cache, persistent version/digest high-water
  marks, revocations and clock floor. Offline reads also persist time advancement.
  Corrupt caches and writer contention fail closed. A crash may leave a lock: recovery
  requires confirming no writer remains before removing it; no unsafe stale takeover.
- `runtime.mjs`: deployment-pinned domain configuration, bounded HTTPS refresh, receipt-backed
  activation, latest-known revocation checks, and fresh authorization for manual rollback.
  Roots are never discovered from marketplace sources. Historical receipts permit offline
  execution after natural expiry, not new installations or revocation bypass.
- Optional `targets.legacy` entries bind extensionId, exact version, archiveDigest, filesDigest,
  publicKey, publisherId and expiresAt. They authorize only the named v1 archive, never a CA.
- Browser hosts use `WOOHAA3_EXTENSION_TRUST_CONFIG`. Desktop builds embed that public file
  as `extension-trust.json`; release desktop hosts ignore inherited root overrides.
- Public `testdata/vectors.json` contains ephemeral test evidence and a v2 archive,
  shared with the private Go consumer. Never trust the `test-only` domain in production.
- The server integrates the same verifier with its durable administration service and
  isolated signer; administrative contracts do not enter the public generated bindings.
  No production signing keys are generated by the implementation.

Run `node --test scripts/lib/extension-trust/trust.test.mjs` plus package/packer tests.
