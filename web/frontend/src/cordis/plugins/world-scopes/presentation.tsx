import type { Context } from "@deepseek-ai/cordis";
import {
  decodeSceneAreaData,
  decodeWorkflowGroupData,
  resolveNodeDisplayName,
  type ServerCanvas,
  type WorldAuthoringConflict,
  type WorldAuthoringPrepareOutcome,
  type WorldObjectContainment,
  type WorldObjectIdentity,
  type WorldScopeOccupancyLock
} from "@woohaa3/contracts";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import "./presentation.css";

type PreparedOutcome = WorldAuthoringPrepareOutcome;

type PrepareState = {
  /** Monotonic request identity; a late response for an older request is discarded. */
  readonly requestId: number;
  /** Canvas/node/scope/revision identity this result belongs to. */
  readonly key: string;
  readonly outcome: PreparedOutcome;
};

type NormalizedOccupancy = {
  state: "idle" | "occupied" | "unknown";
  locks: WorldScopeOccupancyLock[];
  reason?: "store-unavailable" | "not-reported" | "unsupported-version" | "scope-mismatch";
};

const EMPTY_OCCUPANCY: NormalizedOccupancy = {
  state: "unknown",
  locks: [],
  reason: "not-reported"
};

function objectKey(identity: WorldObjectIdentity): string {
  return identity.kind === "instance" ? `instance:${identity.instanceId}` : `camera:${identity.cameraId}`;
}

function sameIdentity(left: WorldObjectIdentity, right: WorldObjectIdentity): boolean {
  return objectKey(left) === objectKey(right);
}

function objectKindLabel(identity: WorldObjectIdentity): string {
  return identity.kind === "instance" ? "模型" : "镜头";
}

function objectIdentityLabel(identity: WorldObjectIdentity): string {
  return identity.kind === "instance" ? `模型 ${identity.instanceId}` : `镜头 ${identity.cameraId}`;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function readTarget(input: unknown): WorldObjectIdentity | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const target = input as Record<string, unknown>;
  if (target.kind === "instance") return nonEmpty(target.instanceId) ? { kind: "instance", instanceId: target.instanceId } : null;
  if (target.kind === "camera") return nonEmpty(target.cameraId) ? { kind: "camera", cameraId: target.cameraId } : null;
  return null;
}

/** Defensive read: a legacy response without occupancy is unknown, never idle. */
function readOccupancy(snapshot: unknown): NormalizedOccupancy {
  if (!snapshot || typeof snapshot !== "object") return EMPTY_OCCUPANCY;
  const raw = (snapshot as { occupancy?: unknown }).occupancy;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_OCCUPANCY;
  const value = raw as Record<string, unknown>;
  if (value.version !== "world-scope-occupancy-v1") {
    return { state: "unknown", locks: [], reason: "unsupported-version" };
  }
  const declaredState = value.state === "idle" || value.state === "occupied" || value.state === "unknown"
    ? value.state
    : "unknown";
  const locks: WorldScopeOccupancyLock[] = [];
  if (Array.isArray(value.locks)) {
    for (const input of value.locks) {
      if (!input || typeof input !== "object" || Array.isArray(input)) continue;
      const lock = input as Record<string, unknown>;
      const target = readTarget(lock.target);
      const runId = lock.runId;
      const epoch = lock.epoch;
      const state = lock.state;
      if (!target || !nonEmpty(runId) || typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 0) continue;
      if (state !== "active" && state !== "cancelled") continue;
      locks.push({ target, runId, epoch, state });
    }
  }
  const reason = value.reason === "store-unavailable" || value.reason === "not-reported" ? value.reason : undefined;
  if (declaredState === "idle" && locks.length > 0) {
    // Never claim idle while the same response still reports locks.
    return { state: "occupied", locks, ...(reason ? { reason } : {}) };
  }
  if (declaredState === "occupied" && locks.length === 0) {
    // A conflict-free "occupied" response is malformed; do not present it as idle.
    return { state: "unknown", locks, reason: "not-reported" };
  }
  return { state: declaredState, locks, ...(reason ? { reason } : {}) };
}

/**
 * The codec validates this before the UI sees it; keep the display fail-closed if an
 * old or untrusted response pairs locks with a different scope.
 */
function occupancyScopeMatches(rawOccupancy: unknown, expected: { areaId: string; scopeVersion: string }): boolean {
  if (!rawOccupancy || typeof rawOccupancy !== "object" || Array.isArray(rawOccupancy)) return true;
  const scope = (rawOccupancy as { scope?: unknown }).scope;
  // An occupancy view that exists without its scope identity cannot be trusted to
  // describe this area; keep its reported locks but mark the state unknown.
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return false;
  const value = scope as { scope?: { kind?: unknown; areaId?: unknown }; scopeVersion?: unknown };
  if (!value.scope || value.scope.kind !== "scene-area") return false;
  return value.scope.areaId === expected.areaId && value.scopeVersion === expected.scopeVersion;
}

function requestIdentityMatches(
  outcome: Extract<PreparedOutcome, { ok: true }>,
  input: { canvasId: string; nodeId: string; areaId: string; version: string }
): boolean {
  const snapshot = outcome.snapshot;
  return snapshot.canvasId === input.canvasId
    && snapshot.areaNodeId === input.nodeId
    && snapshot.area.areaId === input.areaId
    && snapshot.area.scopeVersion === input.version
    && snapshot.scope.scope.kind === "scene-area"
    && snapshot.scope.scope.areaId === input.areaId;
}

function nodeDisplayName(canvas: ServerCanvas | null | undefined, nodeId: string | null): string | null {
  if (!canvas || !nodeId) return null;
  const node = canvas.document.nodes.find(item => item.id === nodeId);
  if (!node) return null;
  const data = canvas.nodeData[nodeId];
  return resolveNodeDisplayName({
    type: node.type,
    explicitName: data?.title,
    prompt: data?.prompt
  }).displayName;
}

function nodeIdForIdentity(canvas: ServerCanvas | null | undefined, identity: WorldObjectIdentity): string | null {
  if (!canvas) return null;
  for (const node of canvas.document.nodes) {
    const data = canvas.nodeData[node.id] as Record<string, unknown> | undefined;
    if (identity.kind === "instance" && (data?.sharedWorldInstance as { instanceId?: unknown } | undefined)?.instanceId === identity.instanceId) {
      return node.id;
    }
    if (identity.kind === "camera" && (data?.worldCamera as { cameraId?: unknown } | undefined)?.cameraId === identity.cameraId) {
      return node.id;
    }
  }
  return null;
}

function targetDisplayName(
  canvas: ServerCanvas | null | undefined,
  objects: readonly { identity: WorldObjectIdentity; nodeId: string | null }[],
  identity: WorldObjectIdentity
): string {
  const entry = objects.find(item => sameIdentity(item.identity, identity));
  return nodeDisplayName(canvas, entry?.nodeId ?? null) ?? objectIdentityLabel(identity);
}

function shortRunId(runId: string): string {
  return runId.length <= 10 ? runId : `${runId.slice(0, 8)}…`;
}

function lockCaption(lock: WorldScopeOccupancyLock): string {
  return lock.state === "active" ? "执行中" : "取消待停止";
}

function lockTitle(lock: WorldScopeOccupancyLock): string {
  return `运行 ${lock.runId} · epoch ${lock.epoch} · ${lockCaption(lock)}`;
}

function containmentLabel(containment: WorldObjectContainment): { label: string; tone: "success" | "info" | "warning" | "muted" } {
  switch (containment) {
    case "writable": return { label: "完整可写", tone: "success" };
    case "read-only": return { label: "部分参考", tone: "info" };
    case "unknown": return { label: "未就绪", tone: "warning" };
    case "outside": return { label: "区外", tone: "muted" };
  }
}

function errorConflicts(conflicts: readonly WorldAuthoringConflict[] | undefined): WorldAuthoringConflict[] {
  return [...(conflicts ?? [])].sort((left, right) => objectKey(left.target).localeCompare(objectKey(right.target)));
}

function ScopePanel({ kind, children }: { kind: "area" | "group"; children: ReactNode }) {
  return (
    <section className="world-scopes" data-scope-kind={kind} aria-label={kind === "area" ? "场景区权限与占用" : "2D 组成员"}>
      {children}
    </section>
  );
}

function ScopeHeader({ title, detail }: { title: string; detail: string }) {
  return (
    <header className="world-scopes__header">
      <div>
        <div className="world-scopes__kind">{title}</div>
        <div className="world-scopes__detail">{detail}</div>
      </div>
      <span className="world-scopes__readonly">只读</span>
    </header>
  );
}

function GroupPanel({
  group,
  canvas
}: {
  group: { groupId: string; scopeVersion: string; memberNodeIds: string[] };
  canvas: ServerCanvas | null | undefined;
}) {
  const members = group.memberNodeIds.map(id => ({
    id,
    name: nodeDisplayName(canvas, id) ?? `已移除对象 ${id}`,
    exists: !!canvas?.document.nodes.some(node => node.id === id)
  }));
  return (
    <ScopePanel kind="group">
      <ScopeHeader title="2D 组" detail={`${members.length} 个成员`} />
      <p className="world-scopes__hint">成员只用于整理画布卡片，不会授予 3D 场景的写权限或占用。</p>
      {members.length === 0
        ? <p className="world-scopes__empty">尚未包含成员</p>
        : (
          <ul className="world-scopes__members">
            {members.map(member => (
              <li key={member.id} className={member.exists ? "world-scopes__member" : "world-scopes__member world-scopes__member--missing"}>
                <span className="world-scopes__member-name" title={member.id}>{member.name}</span>
                {!member.exists ? <span className="world-scopes__tag world-scopes__tag--warning">已移除</span> : null}
              </li>
            ))}
          </ul>
        )}
    </ScopePanel>
  );
}

function OccupancySummary({ occupancy }: { occupancy: NormalizedOccupancy }) {
  if (occupancy.state === "idle") {
    return (
      <div className="world-scopes__occupancy world-scopes__occupancy--idle">
        <span className="world-scopes__dot world-scopes__dot--success" aria-hidden="true" />
        <span>当前无运行占用</span>
      </div>
    );
  }
  if (occupancy.state === "occupied") {
    return (
      <div className="world-scopes__occupancy world-scopes__occupancy--occupied">
        <span className="world-scopes__dot world-scopes__dot--warning" aria-hidden="true" />
        <span>{occupancy.locks.length} 个对象被运行占用</span>
      </div>
    );
  }
  return (
    <div className="world-scopes__occupancy world-scopes__occupancy--unknown">
      <span className="world-scopes__dot world-scopes__dot--warning" aria-hidden="true" />
      <span>
        占用状态未知
        {occupancy.reason === "store-unavailable"
          ? "（存储不可用）"
          : occupancy.reason === "unsupported-version"
            ? "（响应版本不支持）"
            : occupancy.reason === "scope-mismatch"
              ? "（范围身份不一致）"
              : "（响应未提供）"}
      </span>
    </div>
  );
}

function ObjectRow({
  canvas,
  objects,
  identity,
  containment,
  locks
}: {
  canvas: ServerCanvas | null | undefined;
  objects: readonly { identity: WorldObjectIdentity; nodeId: string | null }[];
  identity: WorldObjectIdentity;
  containment: WorldObjectContainment;
  locks: readonly WorldScopeOccupancyLock[];
}) {
  const state = containmentLabel(containment);
  return (
    <li className={`world-scopes__object world-scopes__object--${state.tone}`}>
      <div className="world-scopes__object-main">
        <span className="world-scopes__object-name" title={objectKey(identity)}>{targetDisplayName(canvas, objects, identity)}</span>
        <span className="world-scopes__object-kind">{objectKindLabel(identity)}</span>
        <span className={`world-scopes__tag world-scopes__tag--${state.tone}`}>{state.label}</span>
      </div>
      {locks.length > 0
        ? (
          <ul className="world-scopes__locks">
            {locks.map(lock => (
              <li key={`${objectKey(identity)}:${lock.runId}:${lock.epoch}:${lock.state}`} className={`world-scopes__lock world-scopes__lock--${lock.state}`} title={lockTitle(lock)}>
                <span>{lockCaption(lock)}</span>
                <span className="world-scopes__lock-id">{shortRunId(lock.runId)}</span>
                <span className="world-scopes__lock-epoch">e{lock.epoch}</span>
              </li>
            ))}
          </ul>
        )
        : null}
    </li>
  );
}

function AreaPanel({
  state,
  canvas
}: {
  state: PrepareState | null;
  canvas: ServerCanvas | null | undefined;
}) {
  if (!state) {
    return (
      <ScopePanel kind="area">
        <ScopeHeader title="场景区" detail="正在读取权限与占用" />
        <p className="world-scopes__empty" role="status">正在读取场景上下文…</p>
      </ScopePanel>
    );
  }
  const outcome = state.outcome;
  if (!outcome.ok) {
    const conflicts = errorConflicts(outcome.conflicts);
    return (
      <ScopePanel kind="area">
        <ScopeHeader title="场景区" detail="上下文未就绪" />
        <p className="world-scopes__failure" role="alert">
          {outcome.code === "cancelled" ? "请求已取消" : outcome.message}
        </p>
        {conflicts.length > 0
          ? (
            <ul className="world-scopes__conflicts">
              {conflicts.map(conflict => (
                <li key={`${objectKey(conflict.target)}:${conflict.runId}:${conflict.epoch}`} className="world-scopes__conflict" title={objectIdentityLabel(conflict.target)}>
                  <span className="world-scopes__object-name">{nodeDisplayName(canvas, nodeIdForIdentity(canvas, conflict.target)) ?? objectIdentityLabel(conflict.target)}</span>
                  <span className="world-scopes__lock-id">{shortRunId(conflict.runId)}</span>
                  <span className="world-scopes__lock-epoch">e{conflict.epoch}</span>
                </li>
              ))}
            </ul>
          )
          : null}
      </ScopePanel>
    );
  }
  const snapshot = outcome.snapshot;
  const occupancy = readOccupancy(snapshot);
  const effectiveOccupancy = occupancyScopeMatches(
    (snapshot as { occupancy?: unknown }).occupancy,
    { areaId: snapshot.area.areaId, scopeVersion: snapshot.area.scopeVersion }
  )
    ? occupancy
    : { state: "unknown" as const, locks: occupancy.locks, reason: "scope-mismatch" as const };
  const objects = snapshot.objects;
  const groups = ([
    { key: "writable", label: "完整可写", containment: "writable" as const },
    { key: "read-only", label: "部分参考", containment: "read-only" as const },
    { key: "unknown", label: "未就绪", containment: "unknown" as const }
  ] as const).map(group => ({
    ...group,
    objects: objects.filter(item => item.containment === group.containment)
  }));
  const total = groups.reduce((sum, group) => sum + group.objects.length, 0);
  return (
    <ScopePanel kind="area">
      <ScopeHeader title="场景区" detail={`${groups[0]!.objects.length} 个完整可写 · ${groups[1]!.objects.length} 个参考`} />
      <OccupancySummary occupancy={effectiveOccupancy} />
      <p className="world-scopes__hint">这里只显示权限与占用，不会获取写授权或占用对象。</p>
      {total === 0 ? <p className="world-scopes__empty">范围内暂无可编辑或参考对象</p> : null}
      {groups.map(group => (
        <section key={group.key} className="world-scopes__section" aria-label={group.label}>
          <div className="world-scopes__section-title">
            <span>{group.label}</span>
            <span className="world-scopes__count">{group.objects.length}</span>
          </div>
          {group.objects.length === 0
            ? <p className="world-scopes__section-empty">暂无</p>
            : (
              <ul className="world-scopes__objects">
                {group.objects.map(item => (
                  <ObjectRow
                    key={objectKey(item.identity)}
                    canvas={canvas}
                    objects={objects}
                    identity={item.identity}
                    containment={item.containment}
                    locks={effectiveOccupancy.locks.filter(lock => sameIdentity(lock.target, item.identity))}
                  />
                ))}
              </ul>
            )}
        </section>
      ))}
    </ScopePanel>
  );
}

export function ScopeContext({ ctx, canvasId }: { ctx: Context; canvasId: string | undefined }) {
  const canvas = useSyncExternalStore(
    woohaa3CanvasStore.subscribe,
    () => workingCanvasOf(woohaa3CanvasStore.getState()),
    () => null
  );
  const selection = useSyncExternalStore(nodeSelectionStore.subscribe, nodeSelectionStore.getSnapshot, nodeSelectionStore.getSnapshot);
  const nodeId = selection.nodeIds.length === 1 ? selection.primaryNodeId : null;
  const data = nodeId ? canvas?.nodeData[nodeId] : undefined;
  const area = decodeSceneAreaData(data?.sceneArea);
  const group = decodeWorkflowGroupData(data?.workflowGroup2d);
  const areaId = area.ok ? area.value.areaId : null;
  const version = area.ok ? area.value.scopeVersion : null;
  const revision = canvas?.revision ?? 0;
  const [state, setState] = useState<PrepareState | null>(null);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const requestRef = useRef(0);
  const stateKeyRef = useRef<string | null>(null);
  const requestKey = canvasId && nodeId && areaId && version !== null
    ? `${canvasId}:${nodeId}:${areaId}:${version}:${revision}`
    : null;

  // Occupancy is a prepare-time snapshot. Another run starting or stopping changes the
  // durable locks without changing the canvas revision, so a selected area re-reads the
  // read-only prepare periodically. It never acquires, issues a context or probes a lease.
  useEffect(() => {
    if (!requestKey) return;
    const id = setInterval(() => setRefreshEpoch(value => value + 1), 5000);
    return () => clearInterval(id);
  }, [requestKey]);

  useEffect(() => {
    if (!requestKey || !areaId || !canvasId || !nodeId || version === null) {
      requestRef.current += 1;
      stateKeyRef.current = null;
      setState(null);
      return;
    }
    const requestId = ++requestRef.current;
    const abort = new AbortController();
    let active = true;
    // Keep the previous snapshot visible during a read-only refresh of the same
    // canvas/node/scope/revision; clear immediately only when identity changed.
    if (stateKeyRef.current !== requestKey) {
      stateKeyRef.current = requestKey;
      setState(null);
    }
    const request = { canvasId, nodeId, areaId, version };
    ctx.canvasRemote.prepareSceneArea({ canvasId, areaId }, abort.signal).then(outcome => {
      if (!active || abort.signal.aborted || requestId !== requestRef.current) return;
      if (outcome.ok && !requestIdentityMatches(outcome, request)) {
        setState({ requestId, key: requestKey, outcome: { ok: false, code: "version-conflict", message: "场景上下文已过期" } });
        return;
      }
      setState({ requestId, key: requestKey, outcome });
    }).catch(() => {
      if (!active || abort.signal.aborted || requestId !== requestRef.current) return;
      setState({ requestId, key: requestKey, outcome: { ok: false, code: "not-ready", message: "无法读取场景上下文" } });
    });
    return () => {
      active = false;
      abort.abort();
    };
  }, [ctx, canvasId, nodeId, areaId, version, revision, requestKey, refreshEpoch]);

  if (!area.ok && !group.ok) return null;
  if (group.ok) {
    return <GroupPanel group={group.value} canvas={canvas} />;
  }
  // A result from a previous node/scope/revision must never render under the new selection.
  const visibleState = state && state.key === requestKey ? state : null;
  return <AreaPanel state={visibleState} canvas={canvas} />;
}
