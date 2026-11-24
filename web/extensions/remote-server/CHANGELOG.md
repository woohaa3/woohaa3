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

## 1.3.0

- 2026-11-24 `1.3.0`（上一版 `1.2.0`）：两把钥匙——access 短、refresh 长，宿主流离多久都能自己回来
  - `1.2.0` 的自动续期有一个真问题：它必须赶在 access 到期**之前**续（远端 `Refresh` 要求旧令牌仍然有效），
    于是续期只能在「到期前 10 分钟」那个窗口里发生。宿主在那个窗口没运行（关一晚上、出差一周），
    会话就过期，只能等人工重新登录——天天使用的人一样会被踢下线。
  - 服务端与契约拆成两把钥匙：`session_token`（access，每次请求的 Bearer，短）与 `refresh_token`
    （refresh，只用于续期，长）。新增 `CANVAS_REFRESH_TTL`（缺省 90 天，必须严格大于 `CANVAS_SESSION_TTL`）。
    refresh 令牌**不是** Bearer 凭证：服务端 `Verify` 只认 access，拿 refresh 调业务面一律 `unauthenticated`。
  - 续期因此从「定时驱动」变成「懒驱动」：`current()` 发现 access 过期而 refresh 仍有效，就地换一对新的。
    定时器退化成"尽量提前换"的优化，不再是会话存活的唯一机会。宿主重启后第一次读会话就会自己接上。
  - 两把钥匙成对轮换、成对撤销：登出时 refresh 一起作废（否则它是个能在 access 死后复活的登出后门）；
    远端明确拒绝才清会话；401 只丢掉那把 access 而保留长期钥匙（两把钥匙下 401 首先意味着"access 过期了"，
    而不是"这个人不能再用了"）。
  - 单令牌部署与旧记录照旧工作：没有 refresh 令牌时会话行为退回 `1.2.0`（定时续期、401 清空会话），
    不需要迁移或重新登录。
