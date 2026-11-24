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

## 1.1.3

- 2026-11-24 `1.1.3`（上一版 `1.1.2`）：chore(security): 收口 Dependabot 228 条告警 (#42)

## 1.2.0

- 2026-11-24 `1.2.0`（上一版 `1.1.3`）：服务端接入的会话在到期前自动轮换续期
  - 远端 `IdentityService.Refresh` 早就实现好了（轮换而非延长，有效期内可无限续），但客户端从没调过它；
    于是配了 `CANVAS_SESSION_TTL`（prod 168h、dev 24h）之后，每周（dev 每天）所有已接入的画布同步、服务端存储与托管生成
    会一起静默失效，徽标从「远端已接入」掉回「本地模式」，且没有任何提示。
  - 会话源新增 `renew()`：到期前 10 分钟用当前会话换下一段，主体与远端地址沿用旧会话；并发共享同一次
    轮换（两个并发 `Refresh` 会互相作废令牌，把正常续期变成一次「被拒绝」）。
  - 结果分三态：`unauthenticated` / `permission_denied` 才清会话要求重新登录；`timeout` / `unreachable` /
    `unavailable` 等一律保留会话到到期时刻并退避重试——一次网络抖动不该把人踢下线。
  - 续期只用会话自身，**不**读 `deviceToken`：人用设备码 / 本机浏览器登录进来的会话同样能自动续，
    不需要在配置文件里留长期令牌（那与「部署凭证只用于无人值守」冲突）。
  - 已经不可用的会话不会被拿去续（必然 401，再被误判成「被明确拒绝」）；纯本地形态不排任何定时器，
    会话一变（登录 / 续期 / 登出 / 401 作废）即重排，因此不需要轮询。
