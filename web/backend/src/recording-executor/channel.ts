/**
 * 宿主录制通道的生命周期装配
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 1.5）。
 *
 * 把路径、注册表与 socket 服务端拼成一个可被 Cordis 插件关闭的对象；失败时返回 `null`
 * 并记录原因，让宿主把录制能力明确标记为不可用（不静默降级到浏览器路径）。
 */
import { RECORDING_PROTOCOL_VERSION } from "@woohaa3/contracts";
import { recordingExecutorPaths } from "./paths.js";
import { RecordingExecutorRegistry, type RecordingExecutorCapability } from "./registry.js";
import { startRecordingExecutorServer, type RecordingExecutorServer } from "./server.js";

export type RecordingExecutorChannel = {
  /** 宿主实例目录（attempts/nonce/lease 所在），与传输类型无关。 */
  directory: string;
  socketPath: string;
  noncePath: string;
  checkoutId: string;
  registry: RecordingExecutorRegistry;
  available: boolean;
  executorCount(): number;
  close(): Promise<void>;
  /**
   * 向当前注册的执行器连接发一条控制消息（任务派发、取消）。
   *
   * 没有连接或写失败返回 false；调用方据此报 `recording-executor-unavailable`。
   */
  sendControl(message: Record<string, unknown>): boolean;
  /** 订阅执行器回传的控制 payload（progress / stateChanged / jobControlResponse）。 */
  onControl(listener: (payload: Record<string, unknown>) => void): () => void;
};

export type RecordingExecutorChannelOptions = {
  env?: Record<string, string | undefined>;
  checkoutDirectory?: string;
  logger?: (event: Record<string, unknown>) => void;
  /** 覆盖协议版本（测试用）。 */
  protocolVersion?: string;
};

/**
 * 建立通道。
 *
 * 收到 `capabilityRequest` 时用注册表裁定：nonce、checkout、协议版本与能力字段都在
 * `RecordingExecutorRegistry.register` 里校验，这里只做协议编解码。
 */
export async function createRecordingExecutorChannel(
  options: RecordingExecutorChannelOptions = {}
): Promise<RecordingExecutorChannel | null> {
  const log = options.logger ?? (() => undefined);
  const protocolVersion = options.protocolVersion ?? RECORDING_PROTOCOL_VERSION;
  let paths;
  try {
    paths = recordingExecutorPaths({
      ...(options.env?.WOOHAA3_RECORDING_RUNTIME_ROOT
        ? { runtimeRoot: options.env.WOOHAA3_RECORDING_RUNTIME_ROOT }
        : {}),
      ...(options.checkoutDirectory ? { checkoutDirectory: options.checkoutDirectory } : {})
    });
  } catch (error) {
    log({
      event: "recording-executor-paths-failed",
      message: error instanceof Error ? error.message : "unknown"
    });
    return null;
  }

  const nonce = RecordingExecutorRegistry.createNonce();
  const registry = new RecordingExecutorRegistry({
    checkoutId: paths.checkoutId,
    registrationNonce: nonce,
    protocolVersion
  });

  // 连接 id 与实例 id 的对应：注册成功后记住，供派发时定位连接。
  const connections = new Map<string, number>();
  const listeners = new Set<(payload: Record<string, unknown>) => void>();
  let currentConnection: number | null = null;

  let server: RecordingExecutorServer;
  try {
    server = await startRecordingExecutorServer({
      paths,
      registrationNonce: nonce,
      logger: log,
      onDisconnect: connectionId => {
        for (const [instance, connection] of connections) {
          if (connection === connectionId) { registry.disconnect(instance); connections.delete(instance); }
        }
        if (currentConnection === connectionId) currentConnection = null;
      },
      handle: inbound => {
        const payload = inbound.message.payload;
        if (inbound.message.payloadName === "capabilityRequest") {
          const capability = (payload.capability ?? {}) as RecordingExecutorCapability;
          const registered = registry.register({
            capability: {
              ...capability,
              checkoutId: capability.checkoutId ?? paths.checkoutId,
              supportedProtocolVersions: capability.supportedProtocolVersions ?? []
            },
            ...(typeof payload.registrationNonce === "string"
              ? { registrationNonce: payload.registrationNonce }
              : {}),
            peerPid: inbound.peer.peerPid,
            peerUid: inbound.peer.peerUid
          });
          if (registered.ok) {
            connections.set(registered.registration.capability.executorInstanceId, inbound.peer.connectionId);
            currentConnection = inbound.peer.connectionId;
          }
          return {
            protocolVersion,
            sequence: String(inbound.message.sequence),
            capabilityResponse: registered.ok
              ? { accepted: true, capability: registered.registration.capability }
              : {
                  accepted: false,
                  error: {
                    stage: "RECORDING_ERROR_STAGE_CAPABILITY",
                    code: registered.code,
                    message: registered.message
                  }
                }
          };
        }
        if (![...connections.values()].includes(inbound.peer.connectionId)) return undefined;
        // 执行器回传的进度/终态：广播给订阅者（宿主录制服务）。
        for (const listener of listeners) {
          try {
            listener({ [inbound.message.payloadName]: payload });
          } catch {
            // 订阅者异常不能影响通道。
          }
        }
        if (inbound.message.payloadName === "leaseHeartbeat") {
          // executor 的心跳只代表它还活着；真正续期由宿主侧调 `registry.renew`。
          const executorInstanceId = typeof payload.executorInstanceId === "string"
            ? payload.executorInstanceId
            : "";
          const renewed = registry.renew(executorInstanceId, inbound.peer.peerPid);
          if (!renewed) {
            log({ event: "recording-executor-lease-rejected", executorInstanceId });
            return undefined;
          }
          return {
            protocolVersion,
            sequence: String(inbound.message.sequence),
            leaseRenewal: {
              sequence: String(inbound.message.sequence),
              executorInstanceId,
              leaseMs: String(Math.max(0, renewed.leaseExpiresAt - Date.now()))
            }
          };
        }
        return undefined;
      }
    });
  } catch (error) {
    log({
      event: "recording-executor-listen-failed",
      message: error instanceof Error ? error.message : "unknown"
    });
    return null;
  }

  return {
    directory: paths.directory,
    socketPath: paths.socketPath,
    noncePath: paths.noncePath,
    checkoutId: paths.checkoutId,
    registry,
    available: true,
    executorCount: () => registry.list().length,
    sendControl(message) {
      const payload = (message.submitJob ?? message.cancelJob) as { job?: { executorInstanceId?: string } } | undefined;
      const connection = payload?.job?.executorInstanceId ? connections.get(payload.job.executorInstanceId) : currentConnection;
      if (connection === null || connection === undefined) return false;
      return server.send(connection, {
        protocolVersion,
        ...message
      } as Record<string, unknown>);
    },
    onControl(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => server.close()
  };
}
