# Changelog

## 1.1.1 — 2026-11-13

- 画布上游能力按版本化注册契约提交，恢复新版宿主下的远端服务扩展激活。

## 1.1.0 — 2026-11-13

- Add Kimodo motion catalog and NPZ result metadata support.
- 声明 `engines.host`：能力依赖的宿主服务面版本（change: 2026-11-13-add-extension-capability-abi）。

## 1.1.1

- 2026-11-13 `1.1.1`（上一版 `1.1.0`）：纯远端模型循环不再声明本机工作目录工具

## 1.1.2

- 2026-11-16 `1.1.2`（上一版 `1.1.1`）：修测试替身跟能力注册 ABI 变更（补 `version`）
  - `tests/backend.test.ts` 的 `ctx.capabilities.register` 仍按旧的 `(id, value)` 双参数登记，
    而 `HostCapabilityService.register` 自 `add-extension-capability-abi` 起接 `{ id, version, value }`
    单对象，导致注册表里存的是 id 与 version 而不是 `value`，19 个用例找不到能力而失败
  - 顺手移除 `tests/assistant-world.integration.test.ts` 里未使用的导入（TS6192）
