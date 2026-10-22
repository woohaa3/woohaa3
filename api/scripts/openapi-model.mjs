import assert from 'node:assert/strict';

const canvas = '/woohaa.canvas.v1.CanvasService/';
const rbac = '/woohaa.rbac.v1alpha1.RBACService/';
const telemetry = '/woohaa.telemetry.v1alpha1.';
const diagnostics = '/woohaa.diagnostics.v1alpha1.ClientDiagnosticsService/';
const diagnosticsAdmin = '/woohaa.diagnostics.v1alpha1.DiagnosticsAdminService/';
const identity = '/woohaa.identity.v1alpha1.IdentityService/';
const profile = '/woohaa.profile.v1alpha1.ProfileService/';
const storage = '/woohaa.storage.v1.StorageService/';
const generation = '/woohaa.generation.v1alpha1.GenerationService/';
const admin = { mode: 'permission', permission: 'rbac.manage', scope: '*' };

// Documentation metadata, not an authorization engine. Every generated method
// must be classified; adding or deleting an RPC fails generation until reviewed.
// 画布权限是多层的，接口按层拆开：作者（canvas.write / canvas.share）、协作者
// （viewer 只读、editor 可写）、部署管理员（canvas.compact / rbac.manage）。
// 三条通道互不推导，因此下列策略里看不到"作者"这个 mode——它是画布内部的通道，
// 不是 HTTP 层的判定形态。
const canvasRead = { mode: 'permission', permission: 'canvas.read', scope: 'canvasId' };

export const policies = {
  [canvas + 'CreateCanvas']: { mode: 'authenticated', description: '创建一张画布，调用者成为作者。canvas_id 由服务端分配（客户端不能自报）。开发模式下匿名主体可以创建，生产部署要求已认证主体。' },
  [canvas + 'GetCanvas']: { mode: 'permission', permission: 'canvas.read', scope: 'canvasId', get: true, description: '返回画布元数据，并回填调用者的角色、是否作者与有效动作。看不见的画布与不存在返回同一结论（not_found），避免成为存在性探测。' },
  [canvas + 'RenameCanvas']: { mode: 'permission', permission: 'canvas.write', scope: 'canvasId', description: '作者与可写协作者能改名。带 expectedUpdatedAt 时在并发改名冲突下返回 aborted。' },
  [canvas + 'DeleteCanvas']: { mode: 'permission', permission: 'canvas.share', scope: 'canvasId', description: '删除画布（墓碑）。只有作者与部署管理员能删：可写协作者不蕴含删除。删除幂等；删除后访问返回 not_found，中继给出不可重试的 canvas-deleted。' },
  [canvas + 'ListMyCanvases']: { mode: 'filtered', permission: 'canvas.read', scope: 'each returned canvas', get: true, description: '我的画布：作为作者或协作者的那些。管理员看得到别人的画布，但别人的画布不会出现在他的目录里。' },
  [canvas + 'AdminListCanvases']: { mode: 'permission', permission: 'rbac.manage', scope: '*', get: true, description: '部署管理员的画布清单（含可选的墓碑与存储统计）。非管理员一律拒绝，而不是返回空列表。' },
  [canvas + 'AdminListCanvasRecords']: { ...admin, get: true, description: '管理端的记录与快照清单（只有元数据，不含字节），仅部署管理员。按 seq 升序；快照与它后面的 update 一起返回，因此调用方不需要理解"快照覆盖到哪"就能按顺序应用。`cursor` 是客户端续传用的游标（快照等于 `covers`），与主键 `seq` 不是同一个概念。默认 100 条、最多 500 条，`nextAfterSeq` 为 0 表示没有更多。' },
  [canvas + 'AdminReadCanvasRecords']: { ...admin, get: true, description: '管理端按 seq 升序读取记录字节，仅部署管理员，用于多版本解码与对比。服务端不解析 Yjs、也不替调用方合并：按顺序把每条 update 应用到文档上即可重建任意版本。单次默认 1 MiB、最多 4 MiB，按整条记录截断（不会返回半条 update）；`more` 表示还有更多。' },
  [canvas + 'ListCanvasMembers']: { ...canvasRead, get: true, description: '协作者清单。能改分享的调用者（作者与管理员）拿到完整名单；其余协作者只看到自己那一条。' },
  [canvas + 'UpsertCanvasMember']: { mode: 'permission', permission: 'canvas.share', scope: 'canvasId', description: '新增或调整协作者角色（viewer/editor）。作者本人不能被登记成协作者：作者身份只有一个来源。' },
  [canvas + 'RemoveCanvasMember']: { mode: 'permission', permission: 'canvas.share', scope: 'canvasId', description: '移除协作者。撤销在下一次帧与下一次请求上立即生效。' },
  [canvas + 'TransferCanvas']: { mode: 'permission', permission: 'canvas.share', scope: 'canvasId', description: '转让作者身份。只给当前作者与部署管理员。旧作者的访问默认彻底移除，可用 previousOwnerRole 显式降为协作者。' },
  [canvas + 'CreateCanvasInvite']: { mode: 'permission', permission: 'canvas.share', scope: 'canvasId', description: '创建一条协作邀请（角色 viewer/editor + 有效期，默认 7 天、上限 90 天），返回**服务端拼好的**分享页地址（依赖部署 public_base_url）。token 只在创建时返回一次，库中只存哈希；作者与部署管理员可创建。' },
  [canvas + 'ListCanvasInvites']: { mode: 'permission', permission: 'canvas.share', scope: 'canvasId', description: '列出这张画布仍然存在的邀请：角色、创建者、到期时间、接受次数与是否已撤销。不返回 token 或链接（服务端只存哈希），需要再分享时重新创建。' },
  [canvas + 'RevokeCanvasInvite']: { mode: 'permission', permission: 'canvas.share', scope: 'canvasId', description: '撤销一条邀请。撤销后分享页与 AcceptCanvasInvite 都拒绝；已经接受并成为协作者的人不会被自动移除（移除成员是 RemoveCanvasMember 的职责）。' },
  [canvas + 'AcceptCanvasInvite']: { mode: 'authenticated', description: '用邀请 token 接受协作：把调用者加成该邀请角色（viewer/editor），返回画布元数据。要求已认证主体；邀请过期或已撤销返回 failed_precondition，token 不存在返回 not_found（不做存在性探测）。作者本人接受自己的邀请返回 invalid_argument。' },
  [canvas + 'GetCanvasShare']: { ...canvasRead, get: true, description: '分享设置与修订号：restricted / everyone_view / everyone_edit。everyone_* 让拿到链接的**已认证**主体可读（edit 时可写），不是匿名公开，链接也不会让画布进入对方目录。' },
  [canvas + 'UpdateCanvasShare']: { mode: 'permission', permission: 'canvas.share', scope: 'canvasId', description: '更新分享设置（restricted / everyone_view / everyone_edit）。作者与部署管理员可改。expectedRevision 非 0 且与库中不一致时返回 aborted。' },
  [canvas + 'ListCanvases']: { mode: 'permission', permission: 'rbac.manage', scope: '*', get: true, description: 'AdminListCanvases 的兼容别名：部署管理员的全部画布存储统计。非管理员拒绝。' },
  [canvas + 'GetCanvasStats']: { ...canvasRead, get: true, description: '单张画布的存储统计。作者、协作者与管理员都能看，但未登记的画布对所有人都没有读权限。' },
  [canvas + 'CompactCanvas']: { mode: 'permission', permission: 'canvas.compact', scope: 'canvasId', description: '立即把 update 合并成快照。运维动作：只有部署管理员能触发，作者与协作者都不行。未配置合并进程返回 failed_precondition。' },
  '/woohaa.ops.v1.OpsService/GetServerInfo': { mode: 'public', get: true, description: '公开的实例构建与启动信息，无需凭证。' },
  [rbac + 'ListRoles']: { ...admin, description: '列出服务端 roles 表里的角色（当前内置 user/admin；表结构允许自定义角色），含展示名、说明、内置标记与角色直接声明的权限码。画布维度的角色不在这里：它由 CanvasService 的成员接口表达。' },
  [rbac + 'ListPermissions']: { ...admin, description: '返回权限码目录：每个码的含义，以及直接声明它的角色。当前没有通配与角色继承；画布内容权限（canvas.read / canvas.write / canvas.share）由作者与协作者通道判定，角色定义里的声明不单独授予画布访问。仅全局管理员。' },
  [rbac + 'ListBindings']: { ...admin, description: '列出指定 actorId 的绑定；actorId 为空时列出全库绑定。只有全局管理员可查询。' },
  [rbac + 'GrantBinding']: { ...admin, description: '幂等授予全局角色绑定。scope 只接受 *：画布维度的授权必须走 CanvasService.UpsertCanvasMember，两套来源同时生效会让"谁能改这张画布"有两个答案。' },
  [rbac + 'RevokeBinding']: { ...admin, description: '幂等回收绑定。回收最后一个全局管理员返回 failed_precondition；回收后的请求和会话帧重新检查权限，不追溯回滚已授权的在途操作。' },
  [rbac + 'ListActors']: { ...admin, description: '列出主体登记表（这台部署上有谁），含来源渠道、全局角色、作者/协作者画布数与两个时间列。显示名由服务端按"管理员显示名 → 本人昵称 → 配置展示标识 → 主体标识"回退，客户端不重复实现。仅全局管理员；单次最多 5000 行，超出时 truncated 为 true（界面必须提示而不是表现成完整清单）。不返回令牌、会话或渠道外部标识。' },
  [rbac + 'CreateActor']: { ...admin, description: '预登记一个尚未登录的主体，用于在某人首次登录前就授予角色。actorId 必须与渠道上的标识完全一致（机器凭证的 actor_id 或网关 LoginName），否则首次登录会得到另一个主体；已存在返回 already_exists，不静默成功。' },
  [rbac + 'UpdateActor']: { ...admin, description: '只改管理员维护的两个字段：显示名（上限 64 字符）与备注（上限 512 字符）。actorId 是身份键，不可修改——换标识属于主体合并/拆分，不在本接口内。显示名会覆盖本人昵称作为全系统展示名。' },
  [rbac + 'SetActorStatus']: { ...admin, description: '停用或启用一个主体。停用在同一个事务里撤销它的全部会话，因此下一次请求即返回 permission_denied，重新登录也被拒绝；启用只恢复状态、不恢复已撤销的会话。管理员锚点与"最后一名启用的全局管理员"拒绝停用（failed_precondition，两种文案分开）。' },
  [rbac + 'GetSelf']: { mode: 'authenticated', description: '返回当前主体的全局绑定及部署维度的有效动作。scope 省略或为空时取 *，其他取值返回参数错误（画布维度请查 CanvasService.GetCanvas 的 allowedActions）；仅限非匿名身份。' },
  [telemetry + 'TelemetryService/ReportEvents']: { mode: 'authenticated', description: '仅接受非匿名主体，actor 由服务端认证上下文决定。每批最多 100 个事件、请求最多 16 KiB；未知或零枚举拒绝整批，非法 traceId 丢弃。每分钟每主体 600 单位、每实例 6000 单位，每事件一单位，空批计一单位，限流桶最多 4096。保留 7 天／最多 100000 行。客户端应 best-effort 上报未出站本地诊断，不把遥测失败升级为业务失败。' },
  [telemetry + 'TelemetryAdminService/ListEvents']: { ...admin, get: true, description: '全站诊断事件分页查询，仅全局管理员。按 ID 倒序，默认 50 条、最多 200 条，过期事件始终排除。pageToken 使用上页 nextPageToken；空 token 从最新记录开始。' },
  [diagnostics + 'ReportDiagnostics']: { mode: 'authenticated', description: '上报有界、已脱敏的客户端诊断条目（连接探测、登录/设备码阶段、同步上游状态与错误短语）。仅接受非匿名主体，actor 由服务端认证上下文决定；服务端自行记录接收时间。每批最多 200 条、请求最多 32 KiB；category/event 是稳定标识而不是自由文本，message 上限 512 字符，attributes 是最多 16 对、2048 字节的键值细节（形状不合法的键值对会被丢弃，不会拒绝整条）。条目 best-effort：上报失败不得影响编辑与同步。' },
  [diagnosticsAdmin + 'ListDiagnostics']: { ...admin, get: true, description: '全站客户端诊断条目分页查询，仅部署管理员。按 ID 倒序，默认 50 条、最多 200 条，过期条目始终排除。可按主体、级别、category、event、code、上报端版本、接收时间范围与关键词（大小写不敏感，覆盖说明文本、标识与 attributes 文本）组合筛选；筛选之间是 AND，翻页时必须保持同一组筛选。仍是游标分页、没有聚合与计数：一页就是一页，不是总数。pageToken 使用上页 nextPageToken；空 token 从最新记录开始。' },
  [identity + 'Login']: { mode: 'public', description: '用一份凭证换取短期会话，因此公开：调用方还没有会话。接受的凭证形态由部署配置决定（机器凭证，或上游身份网关注入且经校验的断言），响应形状相同。凭证无效返回未认证；开发模式的匿名主体不能换取会话。响应里的会话令牌是 bearer 凭证，调用方不得记录它。' },
  [identity + 'GetAuthMethods']: { mode: 'public', get: true, description: '公开的登录方式清单。只包含本次部署实际启用的方式，且只含打开登录页的人本来就能看到的取值；未启用的方式不出现，客户端据此渲染入口而不是硬编码。为空表示该部署不提供任何登录方式。' },
  [identity + 'BeginTofLogin']: { mode: 'public', description: '发起一次企业统一登录（浏览器授权方式）。公开：调用方还没有会话。只返回要跳转的统一登录地址（含部署的 appkey 与回调地址，不含任何机密）；把回调与发起方绑定起来的 state 保存在服务端。部署未配置上游身份服务时该方法整体缺席（未实现），而不是返回一个打不开的地址。`return_to` 必须是单个前导斜杠的站内路径，否则拒绝——它会进入回跳地址，跨站值就是一次开放重定向。' },
  [identity + 'CompleteTofLogin']: { mode: 'public', description: '用服务端回调铸出的一次性交接码换取会话。公开：调用方此刻还没有会话。`exchange_code` **不是**上游的授权 code——那个 code 只在服务端换身份时出现一次，从不经过浏览器；交接码一次性、60 秒有效，取出即删。响应与 Login 相同（会话令牌 + 主体 + 到期时刻），令牌不得记录。' },
  [identity + 'ExchangeLocalLogin']: { mode: 'public', description: '用本机 OAuth 授权码换取会话。公开：调用方还没有会话。仅接受服务端在 loopback 回调里签发的一次性码（60 秒、一次性），并校验 PKCE S256 verifier 与 redirect_uri 精确匹配；这里的码不是上游授权 code，会话令牌也不经过浏览器。code、verifier、redirect_uri 任一不匹配返回未认证；重放与过期同结论，不透露码是否曾经有效。' },
  [identity + 'StartDeviceLogin']: { mode: 'public', description: '发起一次设备码登录。公开，理由同 Login：调用方还没有会话，而这正是它存在的前提。返回设备码（客户端保管、不可人工输入）、短码（给人读与输入）、批准页地址（**不含短码**，短码必须由人手动输入——"人比对客户端与页面"是挡住"客户端被登进他人账号"的唯一防线）、建议轮询间隔与过期时刻。设备码与短码都不得记录：前者能换来一份会话，后者能换来一次批准。部署未配置对外地址时该方法整体缺席（未实现），而不是报"设备码无效"。' },
  [identity + 'PollDeviceLogin']: { mode: 'public', description: '轮询一次设备码登录。公开，理由同上。**结果是一个状态而不是错误码**：把"还没批准"表达成错误会让"这次轮询没结果"与"你未认证"变成同一个结论，而它们该有完全不同的走向。已批准时**恰好交付一次**会话凭证，且会话在交付这一刻才签发（待批准期间服务端只记着谁批准了，不持有任何明文令牌）；此后再轮询同一设备码只得到已过期。已拒绝的记录不被消费。' },
  [identity + 'ApproveDeviceLogin']: { mode: 'authenticated', description: '用当前会话的主体批准一次设备码登录。**归属只由当前凭证决定**：请求里只有短码，没有主体——不存在"替某个主体批准"的形状，若存在，任何拿到别人短码的人都能让别人的客户端登进自己指定的账号。同一个主体重复批准幂等成功；换一个人批准被拒（首次批准已决定归属，后来者不得改写）。不存在、已过期、已交付、已被他人批准四种情形返回同一结论，不透露"这份短码是否曾经有效"。' },
  [identity + 'DenyDeviceLogin']: { mode: 'authenticated', description: '拒绝一次设备码登录。与批准同一条归属规则。拒绝同样要求已认证：不要求的话，"猜一个短码把它拒掉"就成了谁都能做的一次打断。拒绝后的记录不可再被批准。' },
  [identity + 'Refresh']: { mode: 'authenticated', description: '用一份仍然有效的会话换新的，并在同一事务内撤销旧的：不存在两份同时有效的前后会话。已失效的会话不能刷新。' },
  [identity + 'Logout']: { mode: 'authenticated', description: '撤销当前会话，幂等。请求体令牌与 Authorization 头不一致时返回未认证且不撤销任何会话，因此不能用一个凭证踢掉别人的会话。' },
  [identity + 'WhoAmI']: { mode: 'authenticated', get: true, description: '返回当前凭证的主体标识、主体类型与过期时间。只返回调用者自己的信息；主体类型不参与任何判定，权限请查 RBACService.GetSelf。' },
  [identity + 'ListIdentities']: { mode: 'authenticated', get: true, description: '列出当前主体已绑定的全部登录方式（渠道 + 该渠道上的标识）。只作用于调用者自己：接口面上没有目标主体参数，因此不存在拿它查别人的形状。同一主体可以由多个登录方式进入，这是"同一个人在多个渠道上是同一个主体"的读模型。' },
  [identity + 'BindIdentity']: { mode: 'authenticated', description: '把另一种登录方式绑到当前主体上。请求里的凭证只证明"我控制这个身份"，**目标主体永远是当前会话**——接口面上没有"绑到某个主体"的形状，否则任何持有他人渠道凭证的人都能把对方身份挂到自己名下，反过来则是直接提权。该身份已属于另一个主体时拒绝，且不透露属于谁（否则失败的绑定会变成"这个渠道对应哪个主体"的探测）。归属规则：未被持有则写入；已属于自己则幂等成功；属于一个"空主体"（仅此一条身份且无角色绑定）则认领并入；否则拒绝。' },
  [identity + 'UnbindIdentity']: { mode: 'authenticated', description: '解绑当前主体的一条登录方式。拒绝解绑最后一条（failed_precondition）：主体没有任何身份等于它再也没有进入方式，角色绑定还在却没人能登进来处理。解绑后用同一渠道再登录会登记出一个**新的零权限主体**——这是预期行为而非权限丢失，客户端必须说明。解绑不属于自己的身份与"不存在"返回同一结论，不透露归属。' },
  [profile + 'GetProfile']: { mode: 'authenticated', get: true, description: '返回调用者自己的昵称、简介与服务端计算的展示名。从未保存过档案时同样成功（字段为空并走展示名回退），且不创建档案行。' },
  [profile + 'UpdateProfile']: { mode: 'authenticated', description: '把档案设置为请求表达的完整状态，空字符串表示清空。昵称上限 64 字符、简介 1024 字符，超限返回参数错误且不产生部分写入。响应携带更新后的完整档案。' },
  [storage + 'HeadObject']: { mode: 'authenticated', get: true, description: '读取对象元数据（存在性、字节数、Content-Type）。对象默认私有：需要 Bearer 会话，匿名主体被拒。键是相对键（`<namespace>/<rest>`），只允许 `[A-Za-z0-9._/-]`、不得以 `/` 开头、不得含 `.`/`..` 段，长度 1..1024。本期是部署级私有：认证通过即可访问同一命名空间，按画布或按主体的隔离尚未提供。' },
  [storage + 'DeleteObject']: { mode: 'authenticated', description: '删除对象，幂等：键本来就不存在同样返回成功。认证要求与 HeadObject 相同。' },
  [storage + 'CreateSignedUrl']: { mode: 'authenticated', get: true, description: '签一个短时地址：`GET` 用于读取（支持 Range），`PUT` 用于写入整对象。没有签名就访问不到字节——这是本服务唯一的字节授权路径。有效期由服务端决定：请求的 `expiresSeconds` 超过上限时按上限收紧，0 取部署默认值。`PUT` 的签名绑定 `contentType`，写入方必须原样发送该请求头，否则 403。签名地址不进日志，客户端不得自行延长有效期。' },
  [storage + 'CreateSignedUrl']: { mode: 'authenticated', get: true, description: '签一个短时地址：`GET` 用于读取（支持 Range），`PUT` 用于写入整对象。没有签名就访问不到字节——这是本服务唯一的字节授权路径。有效期由服务端决定：请求的 `expiresSeconds` 超过上限时按上限收紧，0 取部署默认值。`PUT` 的签名绑定 `contentType`，写入方必须原样发送该请求头，否则 403。签名地址不进日志，客户端不得自行延长有效期。' },
  [generation + 'GetCapabilities']: { mode: 'authenticated', description: '托管生成协议协商。**这是预留契约：服务端实现之前对它的调用返回 unimplemented，客户端保持休眠（纯本地正常态），不得呈现为错误或引导用户配置。** 返回 `protocolVersion`（客户端内置 1，不相等即休眠）、`features`（v1 必须含 `catalog`；未知值忽略）、`pollAfterMs`（建议轮询间隔，0 取客户端默认）、`limits`（prompt 字符数、参考输入条数、参数字节数、文本字符数、各媒体输出字节数与幂等保留期）以及 `modelTypes`/`cancelScopes`（小写词汇）。该接口不返回模型、地址或凭据。' },
  [generation + 'GetCatalog']: { mode: 'authenticated', get: true, description: '服务端权威模型目录，部署级只读：只要求已认证，不按画布或主体过滤。`available=false` 时 `models` 为空、`reason` 给出稳定小写原因码，客户端保持休眠而不是当错误。`catalogRevision` 单调递增，仅用于目录失效判断，不是数据事实源。每个模型自足描述 `modelKey`/`providerId`/`providerModelId`/`modelType`/`title`/`inputSchema`/`defaultInput`/`bindings`/`promptRequirement`/`cancel`/`taskTimeoutMs`/`interaction`/`capabilityFacts`/`capabilities`/`executable`/`unavailableReason`/`schemaRevision`/`configVersion`；单个模型形状非法或 `modelType` 未知时客户端只跳过该模型，不得让整份目录不可用。模型描述、能力自述与原因不得含地址、密钥或内部代号。' },
  [generation + 'SubmitTask']: { mode: 'permission', permission: 'canvas.write', scope: 'canvasId', description: '幂等受理任务，立即返回、不等待终态（执行模型是客户端轮询）。请求携带 `canvasId`、`idempotencyKey`（客户端 workerTaskKey）、模型键/类型、prompt、已校验 `parameters`、稳定参考输入 `inputs`（`assetId`/`role`/`storageKey`/`mediaType`/`mediaKind`，不含 URL 与字节）、`interaction` 与 `admission`（`catalogRevision`/`schemaRevision`/`configVersion`，用提交时看到的目录版本固定受理基准）；`canvasId` 决定 `canvas.write` 判定与结果对象的作用域。同 key 同 payload 返回首次受理的任务（`reused=true`，不重复创建上游任务），同 key 不同 payload 不创建第二个任务并以稳定码 `key-reused` 收敛；画布未同步、目录已变化、超限等稳定拒绝同样不创建上游任务。业务失败以任务状态 `TASK_STATE_FAILED` + `TaskFailure.code` 表达（客户端经 GetTask 读取），只有"调用是否到达服务端"才用 Connect 错误。幂等保留期由 GetCapabilities 的 `limits.idempotencyRetentionSeconds` 公布，必须覆盖客户端重启补提窗口。' },
  [generation + 'GetTask']: { mode: 'permission', permission: 'canvas.read', scope: 'canvasId', get: true, description: '读取任务状态/进度/结果/稳定错误，只读。请求用 `taskId` 或 `idempotencyKey` 二选一引用任务（`idempotencyKey` 指向该 key 首次受理的任务）；授权按任务所属画布判定 `canvas.read`：不在可读范围与不存在返回同一结论，避免成为存在性探测。`state` 是 TaskState 六态枚举（`TASK_STATE_UNSPECIFIED` 按失败处理）；`progress` 是 0..1 小数，只用于展示；`recordRevision` 单调递增，客户端只在它前进时更新视图。成功终态给 `result`（`text` 或 `media`：媒体只有稳定 `storageKey` + `contentType`/`size`/`checksum`/`durationSeconds`/`poster`，**不含签名地址**）；失败终态给 `error`（`code` 与客户端稳定码表同字面量，`message` 是已脱敏固定短语）。任务超出幂等保留期或数据丢失时按不可恢复失败收敛，客户端不自动重提交。' },
  [generation + 'CancelTask']: { mode: 'permission', permission: 'canvas.write', scope: 'canvasId', description: '幂等取消，终态异步收敛：重复取消返回当前状态，已是终态时不做改变。请求只有 `taskId`；授权按任务所属画布判定 `canvas.write`。响应返回任务当前 `state` 与实际生效范围 `cancelScope`（`remote`=已向上游请求取消，`local`=只在服务端侧收敛，`unsupported`=模型不支持取消、状态不变）。模型声明 `cancel=unsupported` 时客户端只做本地取消，不调用本接口。' },
};

const error = (description) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/connect.error' } } } });

export function enrich(spec) {
  assert.deepEqual(Object.keys(spec.paths).sort(), Object.keys(policies).sort(), 'RPC documentation policy coverage has drifted');
  spec.info = {
    title: 'Woohaa 服务端 API', version: '0.1.0',
    description: '从共享 proto 自动生成的 Connect HTTP/JSON API（OpenAPI 3.1）。请求采用 POST + application/json，并发送 Connect-Protocol-Version: 1。64 位整数按 ProtoJSON 字符串表示，字段采用 lowerCamelCase。标记支持 GET 的只读 RPC 也支持 Connect GET 编码，本文件统一展示 POST。\n\n画布权限分三层，互不推导：**作者**（创建者）拥有这张画布，能改内容、改分享、邀请协作者、删除；**协作者**由作者或管理员授予，viewer 只读、editor 可写但不可改分享与删除；**部署管理员**（全局 admin）能看任何画布、合并快照、强制删除，但**不**改画布内容，别人的画布也不会进入他的"我的画布"。Bearer token 只标识主体，权限由服务端按这三条通道现算，不缓存，撤销在下一次请求或下一帧上生效。全局角色只表达部署维度（user=read+write+share，admin=read+compact+manage）；画布维度的授权走 CanvasService 的成员接口，不写 RBAC 绑定。开发 rw/ro 模式仅供本机调试，不提供这些隔离保证。\n\nv1alpha1 的 RBAC 和遥测接口仍在演进。WebSocket /ws/canvases/{canvas} 使用二进制 protobuf 帧（session.proto），不属于 OpenAPI HTTP 请求模型；部署管理员另有一条只读观测通道 /ws/admin/canvases/{canvas}（inspect.proto，InspectorFrame），同样不属于 HTTP 请求模型。健康检查与反射使用标准 gRPC 协议。本文档不表示存在口令登录；IdentityService 支持三种身份来源——部署配置的机器凭证、上游网关注入并校验的断言、以及 上游身份服务 方式的统一登录（浏览器跳转登录页，服务端用 code 换身份）。认证面与权限判定彼此独立。',
  };
  spec.servers = [{ url: '/', description: '部署时替换为服务端公开基址；Swagger 页面仅用于浏览。' }];
  spec.components.securitySchemes = { bearerAuth: { type: 'http', scheme: 'bearer', description: '使用部署配置的独立身份 token，不是 actor ID。公开接口无需 Authorization。' } };
  for (const [path, item] of Object.entries(spec.paths)) {
    assert.deepEqual(Object.keys(item), ['post'], `Unexpected transport at ${path}`);
    const operation = item.post;
    const { description, get = false, ...policy } = policies[path];
    operation.security = policy.mode === 'public' ? [] : [{ bearerAuth: [] }];
    operation['x-woohaa-auth'] = policy;
    operation['x-connect-get-supported'] = get;
    operation.description = [operation.description, description, get ? '此 RPC 同时支持 Connect GET：使用 encoding=json 和 JSON 编码的 message 查询参数。' : '仅使用 POST，不标记为无副作用方法。'].filter(Boolean).join('\n\n');
    operation.responses['400'] = error('invalid_argument：请求或字段不合法。');
    operation.responses['500'] = error('internal：服务端或依赖不可用。');
    if (policy.mode !== 'public') {
      operation.responses['401'] = error('unauthenticated：凭证缺失或无效。');
      operation.responses['403'] = error('permission_denied：主体没有所需权限。');
    }
    for (const response of Object.values(operation.responses)) {
      response.headers = { 'X-Trace-ID': { description: '服务端请求链路 ID。', schema: { type: 'string', pattern: '^[0-9a-f]{32}$' } }, traceparent: { description: 'W3C TraceContext 响应链路上下文。', schema: { type: 'string' } } };
    }
  }
  spec.paths[canvas + 'CompactCanvas'].post.responses['412'] = error('failed_precondition：合并进程未配置。');
  spec.paths[rbac + 'RevokeBinding'].post.responses['412'] = error('failed_precondition：不能撤销最后一个全局管理员。');
  const report = spec.paths[telemetry + 'TelemetryService/ReportEvents'].post;
  report.responses['429'] = error('resource_exhausted：超过请求大小、批次处理预算或限流上限。');
  report['x-max-request-bytes'] = 16384;
  report.requestBody.content['application/json'].example = { events: [{ action: 'ACTION_LOCAL_VALIDATION', result: 'RESULT_REJECTED', client: 'CLIENT_DESKTOP', surface: 'SURFACE_LOCAL_VALIDATION' }] };
  spec.paths[rbac + 'GrantBinding'].post.requestBody.content['application/json'].example = { binding: { actorId: 'device-alice', role: 'user', scope: '*' } };
  // 生成任务只携带稳定引用，不含 URL/字节/签名地址；ProtoJSON 的 64 位整数是字符串。
  spec.paths[generation + 'SubmitTask'].post.requestBody.content['application/json'].example = {
    idempotencyKey: 'worker-task-01HZ', canvasId: 'canvas-demo', modelKey: 'model-demo-image', modelType: 'image',
    prompt: '一只在雨中的猫', parameters: { aspectRatio: '16:9' },
    inputs: [{ assetId: 'asset-1', role: 'reference_image', storageKey: 'media/<sha256>.png', mediaType: 'image/png', mediaKind: 'image' }],
    interaction: { id: 'generic-model', version: 1 },
    admission: { catalogRevision: '42', schemaRevision: '3', configVersion: '7' },
    nodeId: 'node-1', runId: 'run-1'
  };
  // 成功终态：媒体结果只有稳定 storageKey 与 metadata，没有签名地址。
  spec.paths[generation + 'GetTask'].post.responses['200'].content['application/json'].example = {
    taskId: 'task-01HZ', idempotencyKey: 'worker-task-01HZ', state: 'TASK_STATE_SUCCEEDED', progress: 1,
    upstreamTaskId: 'upstream-9f2',
    media: { mediaKind: 'image', storageKey: 'generation-outputs/<sha256>.png', contentType: 'image/png', size: '1048576', checksum: 'sha256-6d1f' },
    timing: { admittedAt: '2026-10-20T00:00:00Z', startedAt: '2026-10-20T00:00:02Z', finishedAt: '2026-10-20T00:00:20Z', stateChangedAt: '2026-10-20T00:00:20Z' },
    recordRevision: '17', updatedAt: '2026-10-20T00:00:20Z'
  };
  const schemas = spec.components.schemas;
  const binding = schemas['woohaa.rbac.v1alpha1.Binding'];
  binding.required = ['actorId', 'role', 'scope'];
  Object.assign(binding.properties.actorId, { minLength: 1, maxLength: 256 });
  // 角色是表里的数据（内置 + 自定义），不在契约里枚举；只约束形状。
  Object.assign(binding.properties.role, {
    minLength: 1,
    maxLength: 64,
    description: '角色标识，必须存在于服务端 roles 表；当前内置 user/admin，也允许自定义角色。'
  });
  binding.properties.scope.pattern = '^(\\*|[A-Za-z0-9_-]{1,64})$';
  for (const name of ['GrantBindingRequest', 'RevokeBindingRequest']) schemas['woohaa.rbac.v1alpha1.' + name].required = ['binding'];
  for (const name of ['GetCanvasStatsRequest', 'CompactCanvasRequest']) {
    const schema = schemas['woohaa.canvas.v1.' + name];
    schema.required = ['canvasId'];
    schema.properties.canvasId.minLength = 1;
  }
  schemas['woohaa.telemetry.v1alpha1.ReportEventsRequest'].properties.events.maxItems = 100;
  schemas['woohaa.telemetry.v1alpha1.ClientEvent'].required = ['action', 'result', 'client', 'surface'];
  Object.assign(schemas['woohaa.telemetry.v1alpha1.ListEventsRequest'].properties.pageSize, { minimum: 0, maximum: 200, default: 50 });
  schemas['woohaa.telemetry.v1alpha1.ListEventsRequest'].properties.pageToken.maxLength = 32;
  Object.assign(schemas['woohaa.diagnostics.v1alpha1.ListDiagnosticsRequest'].properties.pageSize, { minimum: 0, maximum: 200, default: 50 });
  schemas['woohaa.diagnostics.v1alpha1.ListDiagnosticsRequest'].properties.pageToken.maxLength = 32;
  schemas['woohaa.diagnostics.v1alpha1.ReportDiagnosticsRequest'].properties.entries.maxItems = 200;
  // 诊断筛选字段的形状上限：与 diagnostics.Store 的校验保持一致，避免文档把"随便传"当成合法输入。
  // 说明文本与 attributes 的边界同样写在这里：契约里它们是"有界附加信息"，不是自由载荷。
  const diagnosticsFilters = schemas['woohaa.diagnostics.v1alpha1.ListDiagnosticsRequest'].properties;
  diagnosticsFilters.actorId.maxLength = 256;
  diagnosticsFilters.query.maxLength = 128;
  diagnosticsFilters.frontendVersion.maxLength = 64;
  for (const name of ['category', 'event', 'code']) {
    Object.assign(diagnosticsFilters[name], { pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$', maxLength: 64 });
  }
  const diagnosticEntry = schemas['woohaa.diagnostics.v1alpha1.ClientDiagnosticEntry'].properties;
  diagnosticEntry.message.maxLength = 512;
  diagnosticEntry.attributes.maxProperties = 16;
  diagnosticEntry.attributes.additionalProperties = { type: 'string', maxLength: 256 };
  for (const name of ['AdminListCanvasRecordsRequest', 'AdminReadCanvasRecordsRequest']) {
    const schema = schemas['woohaa.canvas.v1.' + name];
    schema.required = ['canvasId'];
    schema.properties.canvasId.minLength = 1;
  }
  Object.assign(schemas['woohaa.canvas.v1.AdminListCanvasRecordsRequest'].properties.pageSize, { minimum: 0, maximum: 500, default: 100 });
  Object.assign(schemas['woohaa.canvas.v1.AdminReadCanvasRecordsRequest'].properties.maxBytes, { minimum: 0, maximum: 4194304, default: 1048576 });
  // v0.14.2 emits numeric enum values but a string-only type. Correct the type
  // union to match ProtoJSON; the service rejects all unspecified enum values.
  for (const schema of Object.values(schemas)) {
    if (schema.enum?.some(value => typeof value === 'number')) schema.type = ['string', 'integer'];
  }
  for (const name of ['Action', 'Result', 'Client', 'Surface']) {
    const schema = schemas['woohaa.telemetry.v1alpha1.' + name];
    schema.enum = schema.enum.filter(value => value !== 0 && !String(value).endsWith('_UNSPECIFIED'));
  }
  return spec;
}

export function renderHTML(spec) {
  const json = JSON.stringify(spec).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Woohaa 服务端 API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css">
<style>body{margin:0;background:#fafafa}.notice{padding:16px 24px;font:14px system-ui;background:#eef2f6}.swagger-ui .topbar{display:none}</style></head>
<body><div class="notice">Woohaa · OpenAPI 3.1 · 文档内嵌，无需读取本地 JSON。浏览组件从 CDN 加载；此页面不发送 API 请求。机器可读契约见同目录 openapi.json。</div><div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({spec:${json},dom_id:'#swagger-ui',deepLinking:true,validatorUrl:null,supportedSubmitMethods:[],persistAuthorization:false});</script>
</body></html>\n`;
}
