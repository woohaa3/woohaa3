/**
 * RunningHub 区域识别结果的持久化（change: 2026-11-17-add-runninghub-region-detection）。
 *
 * 区域是随 API Key 变化的派生状态：Key 在哪个站注册，就只能用哪个站。这里把区域与 Key 的
 * SHA-256 摘要一起写进扩展自己的 owner-scoped 文档 `account/region`，摘要不匹配就重新识别。
 * 只存摘要，不存 Key；日志也不输出摘要。
 *
 * 持久文档不可用或写入失败时退化为进程内缓存：插件仍可工作，重启后重新探测。持久化不是激活
 * 的前置条件。
 */
import { createHash } from "node:crypto";
import type { ExtensionDocumentStore, ExtensionDocumentValue } from "@woohaa3/contracts";
import { isRunningHubRegion, type RunningHubRegion } from "../region.js";

/** 扩展文档键：单条记录即可，本扩展只有一份 RunningHub 凭据。 */
export const RUNNINGHUB_REGION_DOCUMENT_KEY = "account/region";

export type RunningHubRegionRecord = {
  schemaVersion: 1;
  region: RunningHubRegion;
  /** 当前 Key 的不可逆摘要；只用于判断 Key 是否变化。 */
  keyFingerprint: string;
  detectedAt: number;
};

export type RunningHubRegionStore = {
  /** 返回与当前 Key 匹配的区域；记录不存在、损坏或摘要不匹配时返回 undefined。 */
  load(apiKey: string): Promise<RunningHubRegion | undefined>;
  /** 写入区域；返回是否至少写进了进程内缓存（持久化失败不影响本次使用）。 */
  save(apiKey: string, region: RunningHubRegion): Promise<boolean>;
};

export function runningHubKeyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey.trim()).digest("hex");
}

function recordOf(value: unknown): RunningHubRegionRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return undefined;
  if (!isRunningHubRegion(record.region)) return undefined;
  if (typeof record.keyFingerprint !== "string" || record.keyFingerprint === "") return undefined;
  if (typeof record.detectedAt !== "number" || !Number.isFinite(record.detectedAt)) return undefined;
  return {
    schemaVersion: 1,
    region: record.region,
    keyFingerprint: record.keyFingerprint,
    detectedAt: record.detectedAt
  };
}

export function createRunningHubRegionStore(
  options: {
    documents?: ExtensionDocumentStore;
    now?: () => number;
    /** 测试可注入；缺省 SHA-256。 */
    fingerprint?: (apiKey: string) => string;
  } = {}
): RunningHubRegionStore {
  const fingerprintOf = options.fingerprint ?? runningHubKeyFingerprint;
  const now = options.now ?? Date.now;
  let memory: RunningHubRegionRecord | undefined;

  return {
    async load(apiKey) {
      const fingerprint = fingerprintOf(apiKey);
      if (memory && memory.keyFingerprint === fingerprint) return memory.region;
      if (!options.documents) return undefined;

      let read: Awaited<ReturnType<ExtensionDocumentStore["get"]>>;
      try {
        read = await options.documents.get(RUNNINGHUB_REGION_DOCUMENT_KEY);
      } catch {
        return undefined;
      }
      if (!read.found) return undefined;
      const record = recordOf(read.document.value);
      if (!record || record.keyFingerprint !== fingerprint) return undefined;
      memory = record;
      return record.region;
    },

    async save(apiKey, region) {
      const record: RunningHubRegionRecord = {
        schemaVersion: 1,
        region,
        keyFingerprint: fingerprintOf(apiKey),
        detectedAt: now()
      };
      memory = record;
      if (!options.documents) return true;
      try {
        const result = await options.documents.batch([
          { op: "set", key: RUNNINGHUB_REGION_DOCUMENT_KEY, value: record as unknown as ExtensionDocumentValue }
        ]);
        return result.ok;
      } catch {
        return false;
      }
    }
  };
}
