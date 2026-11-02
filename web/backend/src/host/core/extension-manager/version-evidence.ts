import type { InstallationRecord } from "./types.js";

export type VersionEvidence = NonNullable<InstallationRecord["versions"]>[string];

/**
 * 取某个版本安装时记录的证据。
 *
 * 兼容窗口：本次改动之前安装的受管扩展没有 `versions` 表。它们仍然可用，但只有顶层
 * `filesDigest` / `trust`，不能冒充任意版本的证据。等所有受管根都重新安装过一遍
 * 之后可以删掉这里的回退（见 COMPATIBILITY.md）。
 */
export function versionEvidence(record: InstallationRecord | undefined, version: string): VersionEvidence | undefined {
  return record?.versions?.[version];
}

/** 记录是否产生于 v2 证据之前（没有逐版本证据表）。 */
export function isLegacyRecord(record: InstallationRecord | undefined): boolean {
  return !record?.versions || record.packageDigest === undefined || record.filesDigest === undefined;
}

/**
 * 指针切到某版本时套用的字段：有证据就用证据；没有证据时必须清掉上一版本的内容摘要与信任，
 * 否则 `installed()` 会拿旧摘要对新目录，把正常回滚判成内容被改。
 *
 * `packageDigest` 刻意保留：它是归档字节的摘要、与具体版本一一对应，既不会和别的版本
 * 混淆，又是 v1 精确迁移（legacy grant）唯一能用的凭据。清掉它会让老记录回滚后
 * 连迁移清单都查不到。
 */
export function withVersionEvidence(record: InstallationRecord, version: string): InstallationRecord {
  const evidence = versionEvidence(record, version);
  if (evidence) return { ...record, ...evidence };
  if (record.current === version) return { ...record };
  return { ...record, filesDigest: undefined, trust: undefined, evidence: undefined };
}
