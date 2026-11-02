import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonical, exact, parseTrustJson, requireTrust } from "./encoding.mjs";
import { verifyTrustBundle } from "./verify.mjs";

export function readTrustDocument(file, maxBytes = 1024 * 1024) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    requireTrust(stat.isFile() && stat.size <= maxBytes, "document-too-large");
    return parseTrustJson(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(fd)), { maxBytes });
  } finally { fs.closeSync(fd); }
}

/** Single-writer, durable trust state. No network, TOFU, automatic root discovery or stale-lock takeover. */
export function openTrustStore({ directory, pinnedRoot, floors }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "trust.json");
  const lock = path.join(directory, "trust.lock");
  const pinned = parseTrustJson(canonical(pinnedRoot));
  const minimum = parseTrustJson(canonical(floors));
  function read() {
    if (!fs.existsSync(file)) return null;
    const record = readTrustDocument(file);
    exact(record, ["schemaVersion", "rootUpdates", "bundle", "state"]);
    requireTrust(record.schemaVersion === 2, "invalid-store-version");
    return record;
  }
  function verify(record, now) {
    requireTrust(record, "missing-trust-cache");
    return verifyTrustBundle({ pinnedRoot: pinned, rootUpdates: record.rootUpdates, bundle: record.bundle, previousState: record.state, floors: minimum, now });
  }
  const store = {
    snapshot() { return read(); },
    lastVerified() { const record=read(); requireTrust(record,"missing-trust-cache"); return verify(record,record.state.timeFloor); },
    current(now = Math.floor(Date.now() / 1000)) {
      const record = read();
      verify(record, now);
      // Persist the new clock floor even on offline reads; a later clock rollback must not extend TTL.
      return store.update({ bundle: record.bundle, now });
    },
    update({ bundle, rootUpdates = [], now = Math.floor(Date.now() / 1000) }) {
      // Fail on contention rather than allow two writers to publish different high-water marks.
      const fd = fs.openSync(lock, "wx", 0o600);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
        fs.fsyncSync(fd);
        const prior = read();
        const allUpdates = [...(prior?.rootUpdates ?? []), ...rootUpdates];
        const context = verifyTrustBundle({ pinnedRoot: pinned, rootUpdates: allUpdates, bundle, previousState: prior?.state, floors: minimum, now });
        const record = { schemaVersion: 2, rootUpdates: allUpdates, bundle, state: context.nextState };
        const bytes = canonical(record);
        requireTrust(Buffer.byteLength(bytes) <= 1024 * 1024, "document-too-large");
        const output = fs.openSync(temporary, "wx", 0o600);
        try { fs.writeFileSync(output, bytes); fs.fsyncSync(output); } finally { fs.closeSync(output); }
        fs.renameSync(temporary, file);
        if (process.platform !== "win32") {
          const dir = fs.openSync(directory, "r");
          try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
        }
        return context;
      } finally {
        fs.rmSync(temporary, { force: true });
        fs.closeSync(fd);
        fs.rmSync(lock, { force: true });
      }
    }
  };
  return store;
}
