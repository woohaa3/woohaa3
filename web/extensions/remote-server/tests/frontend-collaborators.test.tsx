/**
 * 「协作」窗口与画布条目入口的渲染测试：只断言**可见语义**与请求形状。
 *
 * 重点锁住这几件容易做错的事：
 * 1. 窗口先读成员名单（写操作开关来自服务端的 canManage）；可管理时才读邀请列表，不轮询；
 * 2. 创建邀请的 body 是 { canvasId, role, expiresInSeconds }，成功后展示**服务端返回的 url**，
 *    复制进剪贴板的也是它——不是用 location.origin 拼出来的地址；
 * 3. url 为空（部署未配置对外地址）时显示错误且不提供复制；
 * 4. 邀请列表展示角色/到期/接受次数/状态（有效 / 已撤销 / 已过期），撤销走独立 handler；
 * 5. canManage=false 时没有邀请区、没有创建/撤销、也不发注定被拒的列表读取；
 * 6. 成员名单保持只读（没有主体标识输入、没有逐行移除）；窗口里没有 everyone / 分享模式残留；
 * 7. 读失败要显示后端的中文 error，且对话框仍可关闭（不能变成关不掉的窗口）。
 *
 * 全部用 fake service / fake transport，不碰真实网络与宿主。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { CanvasSummary } from "@woohaa3/contracts";
import {
  RemoteServerCollaboratorsDialog,
  createRemoteServerCollaboratorsDialogRenderer,
  remoteServerCollaboratorsDialogDefinition
} from "../src/frontend/collaborators-dialog.js";
import type { RemoteCollaboratorsDialogService } from "../src/frontend/collaborators-dialog.js";
import { RemoteServerCollaboratorsAction } from "../src/frontend/collaborators-action.js";
import { createRemoteServerService } from "../src/frontend/remote.js";
import type {
  RemoteCanvasInvite,
  RemoteCanvasInviteCreateResult,
  RemoteCanvasInviteRevokeResult,
  RemoteCanvasInvitesResult,
  RemoteCanvasMembersResult,
  RemoteCanvasMemberView,
  RemoteCanvasRole
} from "../src/shared.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MANAGE_VIEW: RemoteCanvasMemberView = {
  canvasId: "canvas-1",
  owner: "alice",
  isOwner: true,
  role: "editor",
  canManage: true,
  complete: true,
  members: [
    { actorId: "bob", role: "editor", grantedBy: "alice", grantedAt: "2026-10-20T02:03:00.000Z" },
    { actorId: "carol", role: "viewer", grantedBy: "", grantedAt: "" }
  ]
};

const READONLY_VIEW: RemoteCanvasMemberView = {
  canvasId: "canvas-1",
  owner: "",
  isOwner: false,
  role: "viewer",
  canManage: false,
  complete: false,
  members: [{ actorId: "dave", role: "viewer", grantedBy: "alice", grantedAt: "2026-10-20T02:03:00.000Z" }]
};

/** 服务端签发的固定链接：断言界面/剪贴板逐字使用它，而不是本地 origin。 */
const SERVER_INVITE_URL = "https://canvas.example.com/invite/tok-123";

const ACTIVE_INVITE: RemoteCanvasInvite = {
  inviteId: "invite-active",
  role: "viewer",
  createdBy: "alice",
  createdAt: "2026-10-20T00:00:00.000Z",
  expiresAt: "2999-01-01T00:00:00.000Z",
  acceptedCount: 3,
  lastAcceptedAt: "2026-10-21T00:00:00.000Z",
  revoked: false
};
const REVOKED_INVITE: RemoteCanvasInvite = {
  ...ACTIVE_INVITE,
  inviteId: "invite-revoked",
  role: "editor",
  acceptedCount: 0,
  lastAcceptedAt: "",
  revoked: true
};
const EXPIRED_INVITE: RemoteCanvasInvite = {
  ...ACTIVE_INVITE,
  inviteId: "invite-expired",
  expiresAt: "2020-01-01T00:00:00.000Z"
};

type InviteCreateInput = { canvasId: string; role: RemoteCanvasRole; expiresInSeconds: number };
type InviteRevokeInput = { canvasId: string; inviteId: string };

type FakeOptions = {
  load?: () => Promise<RemoteCanvasMembersResult>;
  loadInvites?: () => Promise<RemoteCanvasInvitesResult>;
  createInvite?: (input: InviteCreateInput) => Promise<RemoteCanvasInviteCreateResult>;
  revokeInvite?: (input: InviteRevokeInput) => Promise<RemoteCanvasInviteRevokeResult>;
};

function createFakeService(options: FakeOptions = {}) {
  const loadCanvasMembers = vi.fn<() => Promise<RemoteCanvasMembersResult>>(
    options.load ?? (async () => ({ ok: true as const, ...MANAGE_VIEW }))
  );
  const loadCanvasInvites = vi.fn<() => Promise<RemoteCanvasInvitesResult>>(
    options.loadInvites ??
      (async () => ({ ok: true as const, canvasId: "canvas-1", invites: [{ ...ACTIVE_INVITE }] }))
  );
  const createCanvasInvite = vi.fn<(input: InviteCreateInput) => Promise<RemoteCanvasInviteCreateResult>>(
    options.createInvite ??
      (async (input) => ({
        ok: true as const,
        inviteId: "invite-new",
        role: input.role,
        expiresAt: "2026-10-28T00:00:00.000Z",
        url: SERVER_INVITE_URL
      }))
  );
  const revokeCanvasInvite = vi.fn<(input: InviteRevokeInput) => Promise<RemoteCanvasInviteRevokeResult>>(
    options.revokeInvite ?? (async () => ({ ok: true as const }))
  );
  const service: RemoteCollaboratorsDialogService = {
    api: { loadCanvasMembers, loadCanvasInvites, createCanvasInvite, revokeCanvasInvite }
  };
  return { service, loadCanvasMembers, loadCanvasInvites, createCanvasInvite, revokeCanvasInvite };
}

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

/** 覆盖系统剪贴板（jsdom 没有实现，测试不碰真实 clipboard）。 */
function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.innerHTML = "";
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  let unmounted = false;
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    await act(async () => root.unmount());
    container.remove();
  };
  cleanups.push(unmount);
  return { container, unmount };
}

/** 冲掉一次异步动作（请求 resolve → setState → 可能的重读）的微任务/定时器链。 */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

async function mountDialog(
  service: RemoteCollaboratorsDialogService,
  props: { onClose?: () => void; canvasId?: string; title?: string } = {}
) {
  return mount(
    createElement(RemoteServerCollaboratorsDialog, {
      service,
      canvasId: props.canvasId ?? "canvas-1",
      title: props.title ?? "画布一",
      instanceId: "collaborators-test",
      ...(props.onClose ? { onClose: props.onClose } : {})
    })
  );
}

function text(container: HTMLElement, testId: string): string | null {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
}

async function click(container: HTMLElement, testId: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
  });
  await flush();
}

async function chooseSelect(container: HTMLElement, testId: string, value: string): Promise<void> {
  const select = container.querySelector<HTMLSelectElement>(`[data-testid="${testId}"]`);
  expect(select).not.toBeNull();
  await act(async () => {
    select!.value = value;
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("RemoteServerCollaboratorsDialog（可管理）", () => {
  it("读名单后按 canManage 读邀请；成员表只读，窗口里没有主体标识与 everyone 模式残留", async () => {
    const fake = createFakeService();
    const { container, unmount } = await mountDialog(fake.service);
    await flush();

    // 打开时读一次名单，可管理时再读一次邀请；之后不轮询。
    expect(fake.loadCanvasMembers).toHaveBeenCalledTimes(1);
    expect(fake.loadCanvasMembers).toHaveBeenCalledWith("canvas-1");
    expect(fake.loadCanvasInvites).toHaveBeenCalledTimes(1);
    expect(fake.loadCanvasInvites).toHaveBeenCalledWith("canvas-1");

    const title = container.querySelector("h2");
    expect(title?.textContent).toBe("协作 · 画布一");
    expect(text(container, "remote-server-collaborators-owner")).toBe("alice");
    expect(text(container, "remote-server-collaborators-role")).toBe("你是作者");

    const rows = container.querySelectorAll('[data-testid="remote-server-collaborator-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("bob");
    expect(rows[0]?.textContent).toContain("可写协同");
    expect(rows[1]?.textContent).toContain("carol");
    expect(rows[1]?.textContent).toContain("只读协同");
    // 名单只读：没有操作列，也没有逐行移除。
    expect(container.querySelector('[data-testid="remote-server-collaborators-members"]')?.textContent).not.toContain("操作");
    expect(container.querySelector('[data-testid="remote-server-collaborator-remove"]')).toBeNull();

    // 客户端不再要求手输主体标识。
    expect(container.querySelector('[data-testid="remote-server-collaborator-input"]')).toBeNull();
    expect(container.querySelector('[data-testid="remote-server-collaborator-submit"]')).toBeNull();

    // everyone 三档分享模式已彻底移除：没有选择器、没有保存按钮、没有枚举名文案。
    expect(container.querySelectorAll('[data-testid^="remote-server-share-mode-"]')).toHaveLength(0);
    expect(container.querySelector('[data-testid="remote-server-share-save"]')).toBeNull();
    expect(container.textContent ?? "").not.toContain("everyone");
    expect(container.textContent ?? "").not.toContain("分享模式");

    await unmount();
  });

  it("邀请区展示服务端链接、到期时间与语义说明；默认角色/有效期是只读协同 + 7 天", async () => {
    const fake = createFakeService();
    const { container, unmount } = await mountDialog(fake.service);
    await flush();

    const section = container.querySelector('[data-testid="remote-server-collaborators-invites"]');
    expect(section).not.toBeNull();
    expect(container.querySelector<HTMLSelectElement>('[data-testid="remote-server-invite-role"]')?.value).toBe("viewer");
    expect(container.querySelector<HTMLSelectElement>('[data-testid="remote-server-invite-expiry"]')?.value).toBe("604800");
    const note = text(container, "remote-server-invite-note") ?? "";
    expect(note).toContain("服务端生成");
    expect(note).toContain("登录本部署");
    expect(note).toContain("到期或被撤销后失效");
    expect(note).toContain("已接受的人不会因撤销被移除");

    // 创建后展示服务端返回的 url，并给一个复制动作。
    await click(container, "remote-server-invite-create");
    expect(fake.createCanvasInvite).toHaveBeenCalledWith({
      canvasId: "canvas-1",
      role: "viewer",
      expiresInSeconds: 604800
    });
    expect(container.querySelector<HTMLInputElement>('[data-testid="remote-server-invite-url"]')?.value).toBe(
      SERVER_INVITE_URL
    );
    expect(text(container, "remote-server-invite-expires")).toContain("到期时间：");
    expect(container.querySelector('[data-testid="remote-server-invite-copy"]')).not.toBeNull();
    // 创建后与列表对账（不是把新邀请当成唯一真相）。
    expect(fake.loadCanvasInvites).toHaveBeenCalledTimes(2);
    await unmount();
  });

  it("切换角色与有效期：创建 body 反映所选档位", async () => {
    const fake = createFakeService();
    const { container, unmount } = await mountDialog(fake.service);
    await flush();

    await chooseSelect(container, "remote-server-invite-role", "editor");
    await chooseSelect(container, "remote-server-invite-expiry", "3600");
    await click(container, "remote-server-invite-create");

    expect(fake.createCanvasInvite).toHaveBeenCalledWith({
      canvasId: "canvas-1",
      role: "editor",
      expiresInSeconds: 3600
    });
    await unmount();
  });

  it("复制链接：写入剪贴板的是服务端返回的 url，不是 location.origin 拼的地址", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    stubClipboard(writeText);
    const fake = createFakeService();
    const { container, unmount } = await mountDialog(fake.service);
    await flush();

    await click(container, "remote-server-invite-create");
    await click(container, "remote-server-invite-copy");

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toBe(SERVER_INVITE_URL);
    // 不含 jsdom 的本地 origin，也不是应用基址拼出来的路径。
    expect(writeText.mock.calls[0]?.[0]).not.toContain("localhost");
    expect(text(container, "remote-server-invite-copy-feedback")).toBe("已复制");
    await unmount();
  });

  it("复制失败：显示失败原因，不假装成功", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("clipboard denied");
    });
    stubClipboard(writeText);
    const fake = createFakeService();
    const { container, unmount } = await mountDialog(fake.service);
    await flush();

    await click(container, "remote-server-invite-create");
    await click(container, "remote-server-invite-copy");

    const feedback = text(container, "remote-server-invite-copy-feedback") ?? "";
    expect(feedback).toContain("复制失败");
    expect(feedback).toContain("clipboard denied");
    await unmount();
  });

  it("服务端返回空 url（未配置对外地址）：显示错误，不渲染链接输入框、不提供复制", async () => {
    const fake = createFakeService({
      createInvite: async (input) => ({
        ok: true as const,
        inviteId: "invite-no-url",
        role: input.role,
        expiresAt: "2026-10-28T00:00:00.000Z",
        url: ""
      })
    });
    const { container, unmount } = await mountDialog(fake.service);
    await flush();

    await click(container, "remote-server-invite-create");

    expect(text(container, "remote-server-invite-url-error")).toContain("服务端未配置对外地址，无法生成链接");
    expect(container.querySelector('[data-testid="remote-server-invite-url"]')).toBeNull();
    expect(container.querySelector('[data-testid="remote-server-invite-copy"]')).toBeNull();
    await unmount();
  });

  it("创建失败：显示后端的中文原因，不留下半截链接", async () => {
    const fake = createFakeService({
      createInvite: async () => ({ ok: false as const, error: "只有作者或部署管理员能管理协作邀请" })
    });
    const { container, unmount } = await mountDialog(fake.service);
    await flush();

    await click(container, "remote-server-invite-create");

    expect(text(container, "remote-server-invite-action-error")).toBe("只有作者或部署管理员能管理协作邀请");
    expect(container.querySelector('[data-testid="remote-server-invite-url"]')).toBeNull();
    await unmount();
  });

  it("邀请列表：角色 / 到期 / 接受次数 / 状态；只有有效邀请能撤销，撤销后重读列表", async () => {
    const fake = createFakeService({
      loadInvites: async () => ({
        ok: true as const,
        canvasId: "canvas-1",
        invites: [ACTIVE_INVITE, REVOKED_INVITE, EXPIRED_INVITE]
      })
    });
    const { container, unmount } = await mountDialog(fake.service);
    await flush();

    const rows = container.querySelectorAll('[data-testid="remote-server-invite-row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("只读协同");
    expect(rows[0]?.textContent).toContain("3");
    expect(rows[0]?.querySelector('[data-testid="remote-server-invite-status"]')?.textContent).toBe("有效");
    expect(rows[1]?.querySelector('[data-testid="remote-server-invite-status"]')?.textContent).toBe("已撤销");
    expect(rows[2]?.querySelector('[data-testid="remote-server-invite-status"]')?.textContent).toBe("已过期");

    // 撤销只对「有效」的邀请出现。
    const revokeButtons = container.querySelectorAll('[data-testid="remote-server-invite-revoke"]');
    expect(revokeButtons).toHaveLength(1);
    await click(container, "remote-server-invite-revoke");

    expect(fake.revokeCanvasInvite).toHaveBeenCalledTimes(1);
    expect(fake.revokeCanvasInvite).toHaveBeenCalledWith({ canvasId: "canvas-1", inviteId: "invite-active" });
    expect(fake.loadCanvasInvites).toHaveBeenCalledTimes(2);
    expect(text(container, "remote-server-invite-notice")).toBe("邀请已撤销");
    await unmount();
  });

  it("撤销刚创建的邀请：链接已失效，不再提供复制", async () => {
    const fake = createFakeService({
      loadInvites: async () => ({
        ok: true as const,
        canvasId: "canvas-1",
        invites: [{ ...ACTIVE_INVITE, inviteId: "invite-new" }]
      })
    });
    const { container, unmount } = await mountDialog(fake.service);
    await flush();

    await click(container, "remote-server-invite-create");
    expect(container.querySelector<HTMLInputElement>('[data-testid="remote-server-invite-url"]')?.value).toBe(
      SERVER_INVITE_URL
    );

    await click(container, "remote-server-invite-revoke");
    expect(container.querySelector('[data-testid="remote-server-invite-url"]')).toBeNull();
    expect(container.querySelector('[data-testid="remote-server-invite-copy"]')).toBeNull();
    await unmount();
  });

  it("撤销失败：显示原因，成功提示不出现", async () => {
    const fake = createFakeService({
      revokeInvite: async () => ({ ok: false as const, error: "远端服务暂不可用" })
    });
    const { container, unmount } = await mountDialog(fake.service);
    await flush();

    await click(container, "remote-server-invite-revoke");
    expect(text(container, "remote-server-invite-action-error")).toBe("远端服务暂不可用");
    expect(container.querySelector('[data-testid="remote-server-invite-notice"]')).toBeNull();
    await unmount();
  });

  it("读取邀请失败：显示原因，邀请区与窗口仍可用", async () => {
    const fake = createFakeService({
      loadInvites: async () => ({ ok: false as const, error: "未连接服务端" })
    });
    const onClose = vi.fn();
    const { container, unmount } = await mountDialog(fake.service, { onClose });
    await flush();

    expect(text(container, "remote-server-invites-error")).toContain("未连接服务端");
    expect(container.querySelector('[data-testid="remote-server-collaborators-invites"]')).not.toBeNull();
    await click(container, "remote-server-collaborators-close");
    expect(onClose).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it("没有邀请时显示空态", async () => {
    const fake = createFakeService({
      loadInvites: async () => ({ ok: true as const, canvasId: "canvas-1", invites: [] })
    });
    const { container, unmount } = await mountDialog(fake.service);
    await flush();
    expect(text(container, "remote-server-invites-empty")).toBe("还没有创建邀请。");
    expect(container.querySelector('[data-testid="remote-server-invites"]')).toBeNull();
    await unmount();
  });
});

describe("RemoteServerCollaboratorsDialog（只读）", () => {
  it("canManage=false：没有邀请区、不读邀请列表、没有任何写操作", async () => {
    const fake = createFakeService({
      load: async () => ({ ok: true as const, ...READONLY_VIEW })
    });
    const { container, unmount } = await mountDialog(fake.service);
    await flush();

    expect(fake.loadCanvasInvites).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="remote-server-collaborators-invites"]')).toBeNull();
    expect(container.querySelector('[data-testid="remote-server-invite-create"]')).toBeNull();
    expect(container.querySelector('[data-testid="remote-server-invite-revoke"]')).toBeNull();
    expect(container.querySelector('[data-testid="remote-server-collaborators-members"]')).toBeNull();

    expect(text(container, "remote-server-collaborators-owner")).toBe("无属主");
    expect(text(container, "remote-server-collaborators-role")).toBe("只读协同");
    const partial = text(container, "remote-server-collaborators-partial") ?? "";
    expect(partial).toContain("只有作者或部署管理员能查看完整名单");
    expect(partial).toContain("只读协同");
    await unmount();
  });

  it("canManage=false 但 complete=true：展示只读成员表，仍无邀请区", async () => {
    const fake = createFakeService({
      load: async () => ({ ok: true as const, ...READONLY_VIEW, complete: true })
    });
    const { container, unmount } = await mountDialog(fake.service);
    await flush();

    expect(container.querySelector('[data-testid="remote-server-collaborators-members"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="remote-server-collaborator-row"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="remote-server-collaborators-partial"]')).toBeNull();
    expect(container.querySelector('[data-testid="remote-server-collaborators-invites"]')).toBeNull();
    await unmount();
  });
});

describe("RemoteServerCollaboratorsDialog（失败与关闭）", () => {
  it("读名单失败显示后端 error，且对话框仍可关闭", async () => {
    const fake = createFakeService({
      load: async () => ({ ok: false as const, error: "画布不存在或对你不可见" })
    });
    const onClose = vi.fn();
    const { container, unmount } = await mountDialog(fake.service, { onClose });
    await flush();

    expect(text(container, "remote-server-collaborators-error")).toContain("画布不存在或对你不可见");
    // 读不到名单时也不能摆出「作者/角色」结论，更不能显示邀请区（权限未知）。
    expect(container.querySelector('[data-testid="remote-server-collaborators-summary"]')).toBeNull();
    expect(container.querySelector('[data-testid="remote-server-collaborators-invites"]')).toBeNull();
    expect(fake.loadCanvasInvites).not.toHaveBeenCalled();

    await click(container, "remote-server-collaborators-close");
    expect(onClose).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it("dialog payload 校验：缺 canvasId 拒绝打开，合法 payload 由渲染器接到窗口上", async () => {
    const invalid = remoteServerCollaboratorsDialogDefinition.validatePayload({ title: "画布一" });
    expect(invalid.ok).toBe(false);
    const valid = remoteServerCollaboratorsDialogDefinition.validatePayload({ canvasId: " canvas-1 ", title: "画布一" });
    expect(valid).toEqual({ ok: true, payload: { canvasId: "canvas-1", title: "画布一" } });

    const fake = createFakeService();
    const Renderer = createRemoteServerCollaboratorsDialogRenderer(fake.service);
    const { container, unmount } = await mount(
      createElement(Renderer, {
        instance: {
          instanceId: "instance-1",
          dialogId: "remote-server-collaborators",
          payload: { canvasId: "canvas-1", title: "画布一" },
          parentInstanceId: null,
          dismissible: true,
          busy: false
        },
        requestClose: vi.fn(),
        setBusy: vi.fn(),
        replace: vi.fn()
      })
    );
    await flush();
    expect(fake.loadCanvasMembers).toHaveBeenCalledWith("canvas-1");
    expect(fake.loadCanvasInvites).toHaveBeenCalledWith("canvas-1");
    expect(container.querySelector("h2")?.textContent).toBe("协作 · 画布一");
    await unmount();
  });
});

const connectedSnapshot = {
  phase: "connected" as const,
  serverUrl: "https://canvas.example.com",
  subject: "alice",
  displayName: "Alice",
  expiresAt: 1_800_000_000_000,
  methods: [],
  error: null
};

function makeEntry(overrides: Partial<CanvasSummary> = {}): CanvasSummary {
  return {
    id: "canvas-1",
    title: "远端画布",
    revision: 1,
    updatedAt: "2026-10-19T00:00:00.000Z",
    createdAt: "2026-10-19T00:00:00.000Z",
    nodeCount: 0,
    assetCount: 0,
    sources: ["local", "remote"],
    sync: "synced",
    ...overrides
  };
}

async function connectedService() {
  const transport = {
    request: vi.fn(async (input: { path: string }) => {
      if (input.path.endsWith("/session")) {
        return { ok: true as const, status: 200, data: connectedSnapshot };
      }
      return { ok: false as const, code: "unavailable" as const, error: "未配置" };
    })
  };
  const service = createRemoteServerService(transport);
  await act(async () => {
    await service.refresh();
  });
  return service;
}

async function mountAction(input: {
  service: ReturnType<typeof createRemoteServerService>;
  entry?: CanvasSummary;
  openCollaborators?: (input: { canvasId: string; title: string }) => void;
}) {
  const props = {
    service: input.service,
    entry: input.entry ?? makeEntry(),
    openCanvas: vi.fn(),
    refreshCatalog: vi.fn(async () => undefined),
    openCollaborators: input.openCollaborators ?? vi.fn()
  };
  return {
    ...(await mount(createElement(RemoteServerCollaboratorsAction, props))),
    props
  };
}

describe("画布目录条目动作「协作」", () => {
  it("已连接 + 已在远端：渲染「协作」，点击把画布身份交给 Dialog Service", async () => {
    const service = await connectedService();
    const openCollaborators = vi.fn();
    const { container, unmount } = await mountAction({ service, openCollaborators });

    const button = container.querySelector<HTMLButtonElement>('[data-testid="remote-server-collaborators-open"]');
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe("协作");
    await act(async () => {
      button!.click();
    });
    expect(openCollaborators).toHaveBeenCalledWith({ canvasId: "canvas-1", title: "远端画布" });
    await unmount();
  });

  it("仅本机条目、或尚未连接时不渲染（与「同步远端」互斥）", async () => {
    const service = await connectedService();
    const local = await mountAction({ service, entry: makeEntry({ sources: ["local"], sync: "local-only" }) });
    expect(local.container.querySelector('[data-testid="remote-server-collaborators-open"]')).toBeNull();
    await local.unmount();

    // 未连接：默认 local 快照，不渲染注定失败的入口。
    const disconnected = createRemoteServerService({
      request: async () => ({ ok: false as const, code: "unavailable" as const, error: "未配置" })
    });
    const remote = await mountAction({ service: disconnected });
    expect(remote.container.querySelector('[data-testid="remote-server-collaborators-open"]')).toBeNull();
    await remote.unmount();
  });
});

describe("协作者与邀请请求封装（remote.ts）", () => {
  type Call = { path: string; method?: string; body?: unknown };

  it("读取名单走 canvas-members handler，body 带 canvasId，并把名单解码成视图模型", async () => {
    const calls: Call[] = [];
    const transport = {
      request: vi.fn(async (input: Call) => {
        calls.push(input);
        return { ok: true as const, status: 200, data: { ok: true, ...MANAGE_VIEW } };
      })
    };
    const service = createRemoteServerService(transport);
    const result = await service.api.loadCanvasMembers("canvas-1");

    expect(calls[0]?.path).toBe("/api/extensions/remote-server/handlers/canvas-members");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ canvasId: "canvas-1" });
    expect(result).toEqual({ ok: true, ...MANAGE_VIEW });
  });

  it("读取邀请走 canvas-invites handler，body 带 canvasId，并解码列表", async () => {
    const calls: Call[] = [];
    const transport = {
      request: vi.fn(async (input: Call) => {
        calls.push(input);
        return {
          ok: true as const,
          status: 200,
          data: { ok: true, canvasId: "canvas-1", invites: [ACTIVE_INVITE, REVOKED_INVITE] }
        };
      })
    };
    const service = createRemoteServerService(transport);
    const result = await service.api.loadCanvasInvites("canvas-1");

    expect(calls[0]?.path).toBe("/api/extensions/remote-server/handlers/canvas-invites");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ canvasId: "canvas-1" });
    expect(result).toEqual({ ok: true, canvasId: "canvas-1", invites: [ACTIVE_INVITE, REVOKED_INVITE] });
  });

  it("创建邀请走 canvas-invite-create，body 含 canvasId/role/expiresInSeconds，并原样解码 url", async () => {
    const calls: Call[] = [];
    const transport = {
      request: vi.fn(async (input: Call) => {
        calls.push(input);
        return {
          ok: true as const,
          status: 200,
          data: {
            ok: true,
            inviteId: "invite-new",
            // 宿主契约里的角色是两档应用角色（CANVAS_ROLE_* 只存在于 Connect 线格式）。
            role: "editor",
            expiresAt: "2026-10-28T00:00:00.000Z",
            url: SERVER_INVITE_URL
          }
        };
      })
    };
    const service = createRemoteServerService(transport);
    const result = await service.api.createCanvasInvite({
      canvasId: "canvas-1",
      role: "editor",
      expiresInSeconds: 604800
    });

    expect(calls[0]?.path).toBe("/api/extensions/remote-server/handlers/canvas-invite-create");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ canvasId: "canvas-1", role: "editor", expiresInSeconds: 604800 });
    expect(result).toEqual({
      ok: true,
      inviteId: "invite-new",
      role: "editor",
      expiresAt: "2026-10-28T00:00:00.000Z",
      url: SERVER_INVITE_URL
    });
  });

  it("撤销邀请走 canvas-invite-revoke，body 含 canvasId/inviteId", async () => {
    const calls: Call[] = [];
    const transport = {
      request: vi.fn(async (input: Call) => {
        calls.push(input);
        return { ok: true as const, status: 200, data: { ok: true } };
      })
    };
    const service = createRemoteServerService(transport);
    const result = await service.api.revokeCanvasInvite({ canvasId: "canvas-1", inviteId: "invite-active" });

    expect(calls[0]?.path).toBe("/api/extensions/remote-server/handlers/canvas-invite-revoke");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ canvasId: "canvas-1", inviteId: "invite-active" });
    expect(result).toEqual({ ok: true });
  });

  it("邀请响应形状不符或传输失败都收敛成结构化错误", async () => {
    const broken = createRemoteServerService({
      request: async () => ({ ok: true as const, status: 200, data: { ok: true, invites: "nope" } })
    });
    const listed = await broken.api.loadCanvasInvites("canvas-1");
    expect(listed.ok).toBe(false);
    expect(!listed.ok && listed.error).toContain("形状不符");

    const missingUrl = createRemoteServerService({
      request: async () => ({ ok: true as const, status: 200, data: { ok: true, inviteId: "invite-new" } })
    });
    const created = await missingUrl.api.createCanvasInvite({
      canvasId: "canvas-1",
      role: "viewer",
      expiresInSeconds: 604800
    });
    expect(created.ok).toBe(false);
    expect(!created.ok && created.error).toContain("形状不符");

    const disconnected = createRemoteServerService({
      request: async () => ({ ok: false as const, code: "unavailable" as const, error: "未连接服务端" })
    });
    expect(await disconnected.api.loadCanvasInvites("canvas-1")).toEqual({ ok: false, error: "未连接服务端" });
    expect(
      await disconnected.api.createCanvasInvite({ canvasId: "canvas-1", role: "viewer", expiresInSeconds: 604800 })
    ).toEqual({ ok: false, error: "未连接服务端" });
    expect(await disconnected.api.revokeCanvasInvite({ canvasId: "canvas-1", inviteId: "invite-a" })).toEqual({
      ok: false,
      error: "未连接服务端"
    });
  });

  it("读名单形状不符时收敛成「形状不符」，不把坏数据当名单渲染", async () => {
    const service = createRemoteServerService({
      request: async () => ({ ok: true as const, status: 200, data: { ok: true, canvasId: "canvas-1" } })
    });
    const result = await service.api.loadCanvasMembers("canvas-1");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("形状不符");

    const failed = createRemoteServerService({
      request: async () => ({ ok: false as const, code: "unavailable" as const, error: "未连接服务端" })
    });
    expect(await failed.api.loadCanvasMembers("canvas-1")).toEqual({ ok: false, error: "未连接服务端" });
  });
});
