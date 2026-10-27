/** Desktop-only, explicitly approved immutable archives. No HTTP file-reading endpoint.
 * Native UI owns consent and packaging; this extension owns the authenticated session.
 * Keep every job bound to its approved server and actor, including across restarts.
 */
import { constants } from "node:fs";
import { mkdir, lstat, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { callConnect } from "./connect.js";
import { resolveOutboundUrl } from "./storage/client.js";
import type { RemoteSession } from "./session.js";

const SERVICE = "/woohaa.telemetry.v1alpha1.TelemetryService/";
const MAX_BYTES = 32 * 1024 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
type Job = { schema: 1; id: string; serverUrl: string; actorHash: string; archiveKind: "diagnostics";
  runId: string; trigger: "manual" | "abnormal_exit" | "hang_recovered"; createdAt: number; frontendVersion: string };
type State = { status: "pending" | "complete" | "failed"; phase?: "prepared" | "uploaded"; key?: string; url?: string;
  expiresAt?: number; maxBytes?: number; contentType?: string; attempts: number; nextAttemptAt?: number;
  recordId?: string; error?: string; archiveSha256?: string };
type Upload = { key: string; url: string; expiresAt: string | number; maxBytes: string | number; contentType: string };
type Options = { root: string; session: () => Promise<RemoteSession | null>; fetchImpl?: typeof fetch; now?: () => number };
const actorHash = (s: RemoteSession) => createHash("sha256").update(s.subject).digest("hex");
const matches = (s: RemoteSession | null, j: Job) => s !== null && s.serverUrl === j.serverUrl && actorHash(s) === j.actorHash;

async function readBounded(file: string, max: number): Promise<Buffer> {
  // O_NOFOLLOW plus fstat keeps a spool symlink from turning into an arbitrary file reader.
  if ((await lstat(file)).isSymbolicLink()) throw new Error("invalid-file");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > max) throw new Error("invalid-file");
    // Bound the actual read too, even if another process grows a file after fstat.
    const bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const result = await handle.read(bytes, used, bytes.length - used, null);
      if (result.bytesRead === 0) break;
      used += result.bytesRead;
    }
    if (used !== stat.size) throw new Error("file-changed");
    return bytes.subarray(0, used);
  } finally { await handle.close(); }
}
async function readJson(file: string): Promise<unknown> { return JSON.parse((await readBounded(file, 16384)).toString("utf8")); }
async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
function jobOf(raw: unknown, id: string, now: number): Job | null {
  if (!raw || typeof raw !== "object") return null;
  const j = raw as Job;
  if (j.schema !== 1 || j.id !== id || !UUID.test(id) || j.archiveKind !== "diagnostics" ||
      !IDENTIFIER.test(j.runId) || !["manual", "abnormal_exit", "hang_recovered"].includes(j.trigger) ||
      !/^[a-f0-9]{64}$/.test(j.actorHash) || typeof j.serverUrl !== "string" ||
      !Number.isFinite(j.createdAt) || j.createdAt > now + 60000 || j.createdAt < now - RETENTION_MS ||
      typeof j.frontendVersion !== "string" || j.frontendVersion.length > 64) return null;
  try { const u = new URL(j.serverUrl); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) return null; }
  catch { return null; }
  return j;
}
function uploadOf(value: Upload, size: number, now: number, serverUrl: string) {
  if (!value || typeof value.key !== "string" || !value.key || value.key.length > 1024 ||
      value.contentType !== "application/octet-stream" || !Number.isSafeInteger(Number(value.maxBytes)) ||
      size > Math.min(MAX_BYTES, Number(value.maxBytes)) || !Number.isFinite(Number(value.expiresAt)) || Number(value.expiresAt) * 1000 <= now) throw new Error("invalid-upload");
  const url = new URL(resolveOutboundUrl(value.url, serverUrl, ""));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("invalid-upload");
  return { key: value.key, url: url.href, expiresAt: Number(value.expiresAt) * 1000,
    maxBytes: Number(value.maxBytes), contentType: value.contentType };
}

export function createDiagnosticUploader(options: Options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let busy: Promise<void> | null = null;
  let stopped = false;
  let refreshing: Promise<void> | null = null;
  const abort = new AbortController();
  async function processJob(dir: string, job: Job) {
    let state: State = { status: "pending", attempts: 0 };
    try {
      try {
        const saved = await readJson(path.join(dir, "state.json")) as State;
        if (!saved || !["pending", "complete", "failed"].includes(saved.status) || !Number.isInteger(saved.attempts) || saved.attempts < 0 || saved.attempts > 8) throw new Error("invalid-state");
        state = saved;
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("invalid-state"); }
      if (state.status === "complete" || state.status === "failed" || (state.nextAttemptAt ?? 0) > now()) return;
      // Read once: retries always use the same archived snapshot, never the growing live logs.
      const bytes = await readBounded(path.join(dir, "archive.tar.gz"), MAX_BYTES);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (state.archiveSha256 && state.archiveSha256 !== digest) throw new Error("file-changed");
      state.archiveSha256 = digest;
      let session = await options.session();
      if (stopped || !matches(session, job)) return;
      state.attempts = Math.max(0, state.attempts || 0) + 1;
      if (!state.key || (state.phase !== "uploaded" && (state.expiresAt ?? 0) <= now())) {
        const result = await callConnect<Upload>(fetchImpl, session!.serverUrl, `${SERVICE}CreatePerformanceUpload`, {}, { token: session!.token, signal: abort.signal });
        if (!result.ok) throw new Error(result.code);
        Object.assign(state, uploadOf(result.value, bytes.length, now(), session!.serverUrl), { phase: "prepared" });
        await atomicJson(path.join(dir, "state.json"), state);
      }
      if (state.phase !== "uploaded") {
        session = await options.session();
        if (stopped || !matches(session, job)) return;
        if (!state.url || bytes.length > Math.min(MAX_BYTES, state.maxBytes ?? 0)) throw new Error("invalid-upload");
        // Signed PUT URL has its own narrow credential. Never send the session Bearer to storage.
        const response = await fetchImpl(state.url, { method: "PUT", headers: { "Content-Type": state.contentType! },
          body: Uint8Array.from(bytes).buffer, redirect: "error", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]) });
        if (!response.ok) throw new Error(response.status >= 500 ? "unavailable" : "put-failed");
        await response.body?.cancel();
        state.phase = "uploaded"; delete state.url;
        await atomicJson(path.join(dir, "state.json"), state);
      }
      session = await options.session();
      if (stopped || !matches(session, job)) return;
      const result = await callConnect<{ id: string | number; size: string | number }>(fetchImpl, session!.serverUrl,
        `${SERVICE}CommitPerformanceUpload`, { key: state.key, frontendVersion: job.frontendVersion,
          archiveKind: job.archiveKind, runId: job.runId, trigger: job.trigger }, { token: session!.token, signal: abort.signal });
      if (!result.ok) throw new Error(result.code);
      if (!result.value || !/^[1-9][0-9]*$/.test(String(result.value.id))) throw new Error("invalid-response");
      state = { status: "complete", attempts: state.attempts, recordId: String(result.value.id) };
      await atomicJson(path.join(dir, "state.json"), state);
      await rm(path.join(dir, "archive.tar.gz"), { force: true });
    } catch (error) {
      if (stopped) return;
      // Never persist raw network errors: they can contain a signed URL or remote response text.
      const code = error instanceof Error ? error.message : "unknown";
      const terminal = ["invalid-file", "invalid-state", "file-changed", "invalid-upload", "invalid_argument", "permission_denied", "unimplemented"].includes(code) || ["ENOENT", "ELOOP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "") || state.attempts >= 8;
      state.status = terminal ? "failed" : "pending";
      state.error = terminal ? "诊断包上报失败，请重新手动上报或导出后分享。" : "上报暂未成功，将在连接原服务端和账号后重试。";
      if (terminal) { delete state.url; await rm(path.join(dir, "archive.tar.gz"), { force: true }); }
      state.nextAttemptAt = now() + Math.min(3600000, 30000 * 2 ** Math.min(state.attempts, 7));
      await atomicJson(path.join(dir, "state.json"), state);
    }
  }
  async function publishDestination() {
    if (stopped) return;
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    if ((await lstat(options.root)).isSymbolicLink()) return;
    const session = await options.session();
    if (stopped) return;
    if (!session) await rm(path.join(options.root, "destination.json"), { force: true });
    else await atomicJson(path.join(options.root, "destination.json"), { serverUrl: session.serverUrl, actorHash: actorHash(session), updatedAt: now() });
  }
  function refreshDestination(): Promise<void> {
    if (!refreshing) refreshing = publishDestination().catch(() => undefined).finally(() => { refreshing = null; });
    return refreshing;
  }
  async function run() {
    if (stopped) return;
    await refreshDestination();
    if (stopped || (await lstat(options.root)).isSymbolicLink()) return;
    const session = await options.session();
    // Process at most five pending jobs, while still cleaning every expired receipt.
    let processed = 0;
    const entries = await readdir(options.root, { withFileTypes: true });
    for (const entry of entries.filter(e => e.isDirectory() && UUID.test(e.name)).sort((a,b) => a.name.localeCompare(b.name))) {
      if (stopped) return;
      const dir = path.join(options.root, entry.name);
      try {
        const raw = await readJson(path.join(dir, "job.json"));
        if (raw && typeof raw === "object" && "createdAt" in raw && typeof raw.createdAt === "number" && raw.createdAt < now() - RETENTION_MS) {
          await rm(dir, { recursive: true, force: true });
          continue;
        }
        const job = jobOf(raw, entry.name, now());
        if (!job) {
          const age = now() - (await lstat(dir)).mtimeMs;
          if (age > RETENTION_MS) await rm(dir, { recursive: true, force: true });
          continue;
        }
        if (matches(session, job)) {
          const state = await readJson(path.join(dir, "state.json")).catch(() => null) as State | null;
          if (state?.status === "complete" || state?.status === "failed") continue;
          if (processed++ < 5) await processJob(dir, job);
        }
      } catch { /* Incomplete native staging/corrupt job must not affect editing or other uploads. */ }
    }
  }
  return {
    refreshDestination,
    tick(): Promise<void> {
      if (!busy) busy = run().catch(() => undefined).finally(() => { busy = null; });
      return busy;
    },
    async stop() { stopped = true; abort.abort(); await Promise.all([busy, refreshing]); await rm(path.join(options.root, "destination.json"), { force: true }).catch(() => undefined); }
  };
}

/** Only a desktop launch supplies this path; ordinary browser hosts have no upload worker. */
export function desktopDiagnosticUploadRoot(runDir = process.env.WOOHAA_DESKTOP_RUN_DIR): string | null {
  return runDir && path.isAbsolute(runDir) ? path.join(path.dirname(path.dirname(runDir)), "upload-queue") : null;
}
