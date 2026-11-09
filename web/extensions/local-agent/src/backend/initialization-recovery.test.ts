import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createSupervisorProcessManager } from "./supervisor-client.js";
import { prepareCodexConfigDir, resolveCodexHome } from "./codex-home.js";
import { createCodexAppServerTransport } from "./transports/codex-appserver-transport.js";

// The fixture persists its initialization and native thread in the supervised process,
// while each host generation has a new process manager and stdio connection.
const agent = `
let initialized=false; const threads=new Set();
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line); const emit=x=>console.log(JSON.stringify(x)); let result={};
 if(q.method==='initialize') { if(initialized) return emit({id:q.id,error:{code:-32600,message:'Already initialized'}}); initialized=true; }
 if(q.method==='account/read') result={account:{type:'chatgpt'}};
 if(q.method==='model/list') result={data:[{id:'fixture-model',model:'fixture-model',displayName:'Fixture'}],nextCursor:null};
 if(q.method==='thread/start') {threads.add('retained-thread'); result={thread:{id:'retained-thread'}};}
 if(q.method==='thread/resume') {if(!threads.has(q.params.threadId)) return emit({id:q.id,error:{code:-32600,message:'thread lost'}}); result={thread:{id:q.params.threadId}};}
 if(q.method==='turn/start') result={turn:{id:'turn-1'}};
 emit({id:q.id,result});
 if(q.method==='turn/start') setTimeout(()=>{emit({method:'item/agentMessage/delta',params:{threadId:q.params.threadId,delta:'RECOVERED'}}); emit({method:'turn/completed',params:{threadId:q.params.threadId,turn:{id:'turn-1',status:'completed'}}});},10);
});`;

async function verifyRecovery(real: boolean) {
  // Short path is intentional: macOS Unix domain sockets have a 104-byte limit.
  const root = mkdtempSync(path.join("/tmp", "ir-"));
  const socketPath = path.join(root, "s");
  const supervisor = spawn(process.execPath, [path.resolve(import.meta.dirname, "../../../../../scripts/agent-runtime-supervisor.mjs"),
    "--socket", socketPath, "--state", root, "--token", "test", "--workspace", "recovery"], { stdio: "ignore" });
  const identity = { adapterId: "codex-appserver", owner: "recovery", connectionId: "isolated-check" };
  const managers: ReturnType<typeof createSupervisorProcessManager>[] = [];
  const createHost = () => {
    const manager = createSupervisorProcessManager({ workDirRoot: path.join(root, "work"), portRange: { min: 42000, max: 42010 },
      executableFor: () => real ? process.env.WOOHAA_RECOVERY_CODEX! : process.execPath,
      prepareConfigDir: ({ configDir }) => { if (real) prepareCodexConfigDir(configDir, resolveCodexHome()!); }
    }, { socketPath, token: "test", workspaceKey: "recovery", portRange: { min: 42000, max: 42010 } });
    managers.push(manager);
    return manager;
  };
  const transport = () => createCodexAppServerTransport({ protocolVersion: "2025-06-18", clientVersion: "recovery-test", requestTimeoutMs: 20000, turnTimeoutMs: 120000 });
  if (real) prepareCodexConfigDir(path.join(root, "isolated-config"), resolveCodexHome()!);
  const ensure = (host: ReturnType<typeof createHost>) => host.ensure({ ...identity, kind: "stdio", ...(real ? { env: { CODEX_HOME: path.join(root, "isolated-config", ".codex") } } : {}), args: real ? ["app-server"] : ["-e", agent] });
  try {
    await expect.poll(() => existsSync(socketPath), { timeout: 5000 }).toBe(true);
    const a = createHost();
    const first = await ensure(a);
    expect(first.pid).toBeGreaterThan(0);
    const catalogA = await transport().models!({ ...first, stdio: first.stdio! });
    expect(catalogA.error).toBeUndefined();
    expect(catalogA.models.length).toBeGreaterThan(0);
    const model = real ? (process.env.WOOHAA_RECOVERY_MODEL ?? catalogA.models[0]!.id) : "fixture-model";
    const input = { ...first, stdio: first.stdio!, model, prompt: "Reply with exactly RECOVERED. Do not use tools.", allowedTools: [], toolToken: null, mcpEndpoint: null,
      resumeNativeId: null, signal: new AbortController().signal, onEvent: () => undefined };
    const started = await transport().run(input);
    expect(started.ok, JSON.stringify(started)).toBe(true);
    expect(started.nativeId).toBeTruthy();
    // Host shutdown closes its sockets, never the supervised child.
    await a.stopAll();
    const b = createHost();
    const second = await ensure(b);
    expect(second.pid).toBe(first.pid);
    expect(second.stdio).not.toBe(first.stdio);
    const catalogB = await transport().models!({ ...second, stdio: second.stdio! });
    expect(catalogB.error).toBeUndefined();
    expect(catalogB.models.map(item => item.id)).toContain(model);
    const resumed = await transport().run({ ...input, ...second, stdio: second.stdio!, resumeNativeId: started.nativeId! });
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    expect(resumed.nativeId).toBe(started.nativeId);
    expect(resumed.ok && resumed.outcome.assistantText).toContain("RECOVERED");
    console.info(JSON.stringify({ recovery: real ? "real-codex" : "fixture", samePid: first.pid === second.pid, retainedThread: resumed.nativeId === started.nativeId, models: catalogB.models.length }));
  } finally {
    for (const manager of managers) await manager.stopAll();
    if (supervisor.exitCode === null) {
      const exited = new Promise(resolve => supervisor.once("exit", resolve));
      supervisor.kill("SIGTERM");
      const timeout = setTimeout(() => supervisor.kill("SIGKILL"), 5000);
      try { await exited; } finally { clearTimeout(timeout); }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

// This fixture uses Unix sockets; Windows named-pipe recovery needs its own run.
it.skipIf(process.platform === "win32")("retains the supervised process, model catalog and native session across host generations", () => verifyRecovery(false), 20000);
it.skipIf(process.platform === "win32" || !process.env.WOOHAA_RECOVERY_CODEX)("recovers a real Codex session across host generations", () => verifyRecovery(true), 180000);
