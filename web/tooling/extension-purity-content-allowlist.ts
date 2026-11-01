/**
 * 字段级扩展纯粹性的历史债。由声明字面量扫描生成，清债时删除对应条目。
 * 阶段对应 change 2026-10-26-abstract-extension-content-fields 的后续任务组。
 */
import type { ContentFieldDebt } from "./extension-purity-allowlist.js";

export const CONTENT_FIELD_DEBT: readonly ContentFieldDebt[] = [
  // 2026-10-31：画布「普通组」与「片场」删除后，原登记的内核字段债已随代码一并消失。
];
