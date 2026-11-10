#!/usr/bin/env node
/**
 * woohaa3-executor CLI。
 *
 * 目标：不启动浏览器/画布宿主也能执行已准备的角色回合，并提供 daemon 生命周期与诊断。
 * 只消费 `PreparedAgentRoleTurn`；角色准备由调用方完成，或后续通过 role 子命令扩展。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { startExecutorDaemon } from "./daemon.js";
import { createExecutorClient, followTurn } from "./client.js";
import { builtInExecutors } from "./executors.js";
import { executorEndpoint, workspaceKeyFor } from "./endpoints.js";
import type { AgentRoleChannelCapabilities, AgentRoleImplementation, AgentRoleTargetRef } from "@woohaa3/contracts";
import type { Executor, TurnRunInput, TurnView } from "./protocol.js";
import { channelForDefinition, prepareCliRoleTurn, roleEntries, type CliRoleEntry } from "./roles.js";

type Parsed = {
  command: string;
  argv: string[];
  flags: Map<string, string[]>;
};

const FLAGS_WITH_VALUE = new Set([
  "socket", "state", "workspace", "token", "executor", "executor-module", "prepared",
  "payload", "turn-id", "request-id", "since", "timeout-ms", "owner-pid",
  "role", "role-module", "extension-id", "artifact-id", "input", "context", "target",
  "channel", "tools", "available-tools"
]);

function parse(argv: readonly string[]): Parsed {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("--") ? args.shift()! : "help";
  const flags = new Map<string, string[]>();
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) { rest.push(value); continue; }
    const key = value.slice(2);
    if (key === "json" || key === "follow" || key === "help") {
      flags.set(key, [""]);
      continue;
    }
    if (!FLAGS_WITH_VALUE.has(key)) {
      flags.set(key, [""]);
      continue;
    }
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(key, [...(flags.get(key) ?? []), ""]);
      continue;
    }
    flags.set(key, [...(flags.get(key) ?? []), next]);
    index += 1;
  }
  return { command, argv: rest, flags };
}

function flag(parsed: Parsed, key: string): string | undefined {
  const values = parsed.flags.get(key);
  return values?.[values.length - 1] || undefined;
}

function flagAll(parsed: Parsed, key: string): string[] {
  return parsed.flags.get(key) ?? [];
}

function has(parsed: Parsed, key: string): boolean {
  return parsed.flags.has(key);
}

function stateDir(parsed: Parsed): string {
  return path.resolve(flag(parsed, "state") ?? path.join(process.cwd(), ".local", "agent-runtime"));
}

function workspaceKey(parsed: Parsed): string {
  return flag(parsed, "workspace") ?? workspaceKeyFor(process.cwd());
}

function socketPath(parsed: Parsed): string {
  return flag(parsed, "socket") ?? executorEndpoint({ workspaceKey: workspaceKey(parsed), runtimeDir: stateDir(parsed) });
}

function readTokenFile(directory: string): { token?: string; socketPath?: string } {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(directory, "executor.json"), "utf8")) as { token?: unknown; socketPath?: unknown };
    return {
      ...(typeof value.token === "string" ? { token: value.token } : {}),
      ...(typeof value.socketPath === "string" ? { socketPath: value.socketPath } : {})
    };
  } catch {
    return {};
  }
}

function token(parsed: Parsed): string {
  const fromFlag = flag(parsed, "token");
  if (fromFlag) return fromFlag;
  const env = process.env.WOOHAA3_EXECUTOR_TOKEN;
  if (env) return env;
  const stored = readTokenFile(stateDir(parsed)).token;
  if (stored) return stored;
  throw new Error("缺少 executor token：使用 --token、设置 WOOHAA3_EXECUTOR_TOKEN，或先启动 daemon");
}

function client(parsed: Parsed) {
  return createExecutorClient({
    socketPath: flag(parsed, "socket") ?? readTokenFile(stateDir(parsed)).socketPath ?? socketPath(parsed),
    token: token(parsed),
    workspaceKey: workspaceKey(parsed)
  });
}

function readJsonSource(value: string): unknown {
  const text = value === "-" ? fs.readFileSync(0, "utf8") : value.startsWith("@") ? fs.readFileSync(value.slice(1), "utf8") : fs.existsSync(value) ? fs.readFileSync(value, "utf8") : value;
  return JSON.parse(text) as unknown;
}

async function loadRoleModules(parsed: Parsed): Promise<CliRoleEntry[]> {
  const entries: CliRoleEntry[] = [];
  for (const spec of flagAll(parsed, "role-module")) {
    const url = spec.startsWith("file:") ? spec : pathToFileURL(path.resolve(spec)).href;
    const module = await import(url) as { STANDARD_AGENT_ROLES?: unknown; roles?: unknown; default?: unknown };
    const exported = module.STANDARD_AGENT_ROLES ?? module.roles ?? module.default;
    const list = Array.isArray(exported) ? exported : [exported];
    entries.push(...roleEntries(list as AgentRoleImplementation[], {
      ...(flag(parsed, "extension-id") ? { extensionId: flag(parsed, "extension-id")! } : {}),
      ...(flag(parsed, "artifact-id") ? { artifactId: flag(parsed, "artifact-id")! } : {}),
      moduleLabel: spec
    }));
  }
  return entries;
}

function findRole(entries: readonly CliRoleEntry[], roleId: string): CliRoleEntry {
  const found = entries.find((entry) => entry.namespacedId === roleId);
  if (!found) throw new Error(`角色未加载：${roleId}（使用 --role-module 提供实现）`);
  return found;
}

function parseOptionalJson(parsed: Parsed, key: string): unknown {
  const value = flag(parsed, key);
  if (value === undefined) return undefined;
  return readJsonSource(value);
}

function prepareFromFlags(parsed: Parsed, roles: readonly CliRoleEntry[], requestId = flag(parsed, "request-id") ?? crypto.randomUUID()): import("@woohaa3/contracts").PreparedAgentRoleTurn {
  const roleId = flag(parsed, "role");
  if (!roleId) throw new Error("需要 --role <namespaced-id> 或 --prepared FILE");
  const inputValue = parseOptionalJson(parsed, "input");
  if (inputValue === undefined) throw new Error("需要 --input JSON");
  const context = parseOptionalJson(parsed, "context") ?? {};
  const targetValue = parseOptionalJson(parsed, "target");
  const target: AgentRoleTargetRef = targetValue && typeof targetValue === "object" ? targetValue as AgentRoleTargetRef : {};
  const entry = findRole(roles, roleId);
  const requestedChannel = parseOptionalJson(parsed, "channel");
  const channel: AgentRoleChannelCapabilities = requestedChannel && typeof requestedChannel === "object"
    ? requestedChannel as AgentRoleChannelCapabilities
    : channelForDefinition(entry.definition);
  const requestedTools = flag(parsed, "tools")?.split(",").map((tool) => tool.trim()).filter(Boolean);
  const availableTools = flag(parsed, "available-tools")?.split(",").map((tool) => tool.trim()).filter(Boolean);
  return prepareCliRoleTurn({
    entry,
    roleInput: inputValue,
    context,
    target,
    requestId,
    channel,
    ...(requestedTools ? { requestedTools } : {}),
    ...(availableTools ? { availableTools } : {})
  });
}

async function loadExecutorModules(parsed: Parsed): Promise<Executor[]> {
  const executors: Executor[] = [];
  for (const spec of flagAll(parsed, "executor-module")) {
    const url = spec.startsWith("file:") ? spec : pathToFileURL(path.resolve(spec)).href;
    const module = await import(url) as { createExecutor?: unknown; default?: unknown };
    const factory = module.createExecutor ?? module.default;
    const created = typeof factory === "function" ? await (factory as (input: { stateDir: string }) => unknown)({ stateDir: stateDir(parsed) }) : factory;
    const list = Array.isArray(created) ? created : [created];
    for (const candidate of list) {
      const executor = candidate as Executor | undefined;
      if (!executor || typeof executor.id !== "string" || typeof executor.run !== "function") {
        throw new Error(`执行器模块无效：${spec}`);
      }
      executors.push(executor);
    }
  }
  return executors;
}

function print(value: unknown, asJson: boolean, human: string): void {
  console.log(asJson ? JSON.stringify(value, null, 2) : human);
}

function printTurn(view: TurnView | null): void {
  if (!view) { console.log("(no turn)"); return; }
  console.log(`${view.turnId}  ${view.status}  ${view.kind}/${view.executor}  ${view.updatedAt}`);
  if (view.error) console.log(`  error: ${view.error.code} ${view.error.message}`);
}

async function main(): Promise<number> {
  const parsed = parse(process.argv.slice(2));
  const asJson = has(parsed, "json");
  if (parsed.command === "help" || has(parsed, "help")) {
    console.log(`woohaa3-executor — 独立 Agent / 任务执行运行时

用法：
  woohaa3-executor daemon [--socket P] [--state DIR] [--workspace K] [--token T] [--owner-pid PID]
  woohaa3-executor status|health [--json]
  woohaa3-executor doctor [--json]
  woohaa3-executor ps [--json]
  woohaa3-executor turn prepare --role ID --input JSON [--context JSON] [--target JSON]
                              [--channel JSON] [--tools a,b] [--available-tools a,b]
                              [--role-module FILE] [--extension-id ID] [--artifact-id ID]
  woohaa3-executor turn run --prepared FILE|- [--executor echo|process|ID]
                              [--payload JSON|@FILE] [--turn-id ID] [--request-id ID]
                              [--follow] [--json] [--executor-module FILE]
  woohaa3-executor turn run --role ID --input JSON [--role-module FILE] [--executor ...]
  woohaa3-executor turn query ID [--json]
  woohaa3-executor turn list [--json]
  woohaa3-executor turn cancel ID [--json]
  woohaa3-executor events ID [--since N] [--follow] [--json]

默认端点：<state>/executor.sock（Windows 为命名管道）；token 从 --token / 环境变量 /
<state>/executor.json 读取。`);
    return 0;
  }

  if (parsed.command === "daemon") {
    const generated = flag(parsed, "token") ?? crypto.randomBytes(24).toString("base64url");
    const executors = [...builtInExecutors, ...await loadExecutorModules(parsed)];
    const daemon = await startExecutorDaemon({
      socketPath: flag(parsed, "socket") ?? executorEndpoint({ workspaceKey: workspaceKey(parsed), runtimeDir: stateDir(parsed) }),
      stateDir: stateDir(parsed),
      token: generated,
      workspaceKey: workspaceKey(parsed),
      ...(flag(parsed, "owner-pid") ? { ownerPid: Number(flag(parsed, "owner-pid")) } : {}),
      executors,
      defaultExecutor: "echo",
      logger: (event) => console.error(JSON.stringify(event))
    });
    await new Promise<void>((resolve) => {
      const done = () => void daemon.close().then(resolve);
      process.once("SIGTERM", done);
      process.once("SIGINT", done);
    });
    return 0;
  }

  if (parsed.command === "status" || parsed.command === "health") {
    print(await client(parsed).health(), asJson, "executor daemon: healthy");
    return 0;
  }

  if (parsed.command === "doctor") {
    const api = client(parsed);
    const health = await api.health();
    const processes = await api.listProcesses();
    const turns = await api.listTurns();
    print({ health, processes, turns }, true, [
      `executor daemon: ${health.pid} @ ${health.socketPath}`,
      `workspace: ${health.workspaceKey}`,
      `processes: ${health.processes}`,
      `turns: ${health.turns} (active ${health.activeTurns})`
    ].join("\n"));
    return 0;
  }

  if (parsed.command === "ps") {
    const result = await client(parsed).listProcesses();
    print(result, asJson, result.processes.length === 0
      ? "(no processes)"
      : result.processes.map((entry) => `${entry.adapterId}  ${entry.owner}/${entry.connectionId}  pid=${entry.pid ?? "-"}  ${entry.loopbackUrl ?? entry.stdioPath ?? ""}`).join("\n"));
    return 0;
  }

  if (parsed.command === "turn") {
    const sub = parsed.argv[0];
    if (sub === "prepare") {
      const prepared = prepareFromFlags(parsed, await loadRoleModules(parsed));
      print(prepared, true, JSON.stringify(prepared));
      return 0;
    }
    if (sub === "run") {
      const preparedSource = flag(parsed, "prepared");
      const requestId = flag(parsed, "request-id") ?? crypto.randomUUID();
      const prepared = preparedSource
        ? readJsonSource(preparedSource)
        : prepareFromFlags(parsed, await loadRoleModules(parsed), requestId);
      const payloadSource = flag(parsed, "payload");
      const input: TurnRunInput = {
        turnId: flag(parsed, "turn-id") ?? crypto.randomUUID(),
        requestId,
        kind: prepared && typeof prepared === "object" && "roleRef" in prepared ? "agent" : "generation",
        ...(prepared && typeof prepared === "object" && "roleRef" in prepared ? { prepared: prepared as TurnRunInput["prepared"] } : {}),
        ...(payloadSource ? { payload: readJsonSource(payloadSource) } : {}),
        ...(flag(parsed, "executor") ? { executor: flag(parsed, "executor")! } : {}),
        ...(flag(parsed, "timeout-ms") ? { timeoutMs: Number(flag(parsed, "timeout-ms")) } : {})
      };
      const api = client(parsed);
      const view = await api.runTurn(input);
      if (!has(parsed, "follow")) {
        print(view, asJson, `${view.turnId}  ${view.status}`);
        return view.status === "failed" ? 1 : 0;
      }
      let printed = 0;
      const final = await followTurn(api, view.turnId, {
        since: 0,
        onEvent: (event) => {
          printed += 1;
          console.log(JSON.stringify(event));
        }
      });
      if (printed === 0) print(final, asJson, final ? `${final.turnId}  ${final.status}` : "(no turn)");
      return final?.status === "failed" ? 1 : 0;
    }
    if (sub === "query") {
      const id = parsed.argv[1] ?? flag(parsed, "turn-id");
      if (!id) throw new Error("turn query 需要 turnId");
      printTurn(await client(parsed).queryTurn(id));
      return 0;
    }
    if (sub === "list") {
      const result = await client(parsed).listTurns();
      if (asJson) print(result, true, "");
      else for (const view of result.turns) printTurn(view);
      return 0;
    }
    if (sub === "cancel") {
      const id = parsed.argv[1] ?? flag(parsed, "turn-id");
      if (!id) throw new Error("turn cancel 需要 turnId");
      printTurn(await client(parsed).cancelTurn(id));
      return 0;
    }
    throw new Error(`未知 turn 子命令：${sub ?? "(empty)"}`);
  }

  if (parsed.command === "events") {
    const id = parsed.argv[0];
    if (!id) throw new Error("events 需要 turnId");
    const api = client(parsed);
    let since = Number(flag(parsed, "since") ?? 0);
    if (!has(parsed, "follow")) {
      const page = await api.turnEvents(id, since);
      print(page, asJson, page.events.map((event) => `${event.cursor} ${event.type} ${JSON.stringify(event.payload ?? null)}`).join("\n"));
      return 0;
    }
    const final = await followTurn(api, id, {
      since,
      onEvent: (event) => { since = event.cursor; console.log(JSON.stringify(event)); }
    });
    if (!asJson) printTurn(final);
    return 0;
  }

  throw new Error(`未知命令：${parsed.command}`);
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(`woohaa3-executor: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
);
