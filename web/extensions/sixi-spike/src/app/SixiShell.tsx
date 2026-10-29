/**
 * 四喜作为扩展运行时的外壳。
 *
 * - 默认：完整四喜（真实 `AppLayout` + 侧栏 + 全部页面），不透明地盖住宿主画布；
 * - `/create`：四喜外壳整体撤走，露出宿主的全屏画布，只留一个悬浮返回入口。
 *
 * 关于“画布透出”：`canvas.overlay` 的贡献渲染在宿主画布树内部，祖先的 transform/contain 会让
 * `position: fixed` 被限制在同一个层叠上下文里，画布节点按 DOM 顺序压在外壳之上。
 * 试过 `createPortal(document.body)`：宿主给贡献套了错误边界，渲染期一有问题就直接隐藏整块（实测整块消失），
 * 不适合做正式方案。现在改为：外壳就地渲染 + 在外壳存在期间用 `html[data-sixi-shell]` 让宿主画布层
 * 不可见（只改 visibility，不动布局，画布尺寸与状态不受影响），进入画布态时摘掉该属性。
 */
import '@/styles/global.css';
// 模块求值即生效：抢在宿主画布首次绘制前把画布盖住（见 hostCanvasCurtain.ts）。
import { setHostCanvasHidden } from './hostCanvasCurtain';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { resolvePublicUrl } from '@woohaa3/frontend/extension-api';
import type { CanvasCatalogService, ThemeService } from '@woohaa3/frontend/extension-api';
import { SixiProviders, SixiRoutes } from '@/app/App';
import { setProjectSource } from '@/api/projectSource';
import { ROUTES } from '@/app/paths';
import { useUiStore } from '@/stores/uiStore';
import { HOST_PRESET_ID, modeOfHostPreset, sixiHostPreset } from './hostTheme';
import { createHostProjectSource } from './hostProjectSource';

/** 画布态：四喜外壳不渲染，窗口就是宿主画布。 */
function CanvasMode() {
  const navigate = useNavigate();
  return (
    <button type="button" className="sixi-host-back" onClick={() => navigate(ROUTES.home)}>
      ← 返回四喜
    </button>
  );
}

/**
 * 四喜界面存在期间隐藏宿主画布层。
 *
 * 只做 `visibility`：不卸载、不改尺寸，画布在下面保持存活（切回「创作」不会重载）。
 * 属性放在 `<html>` 上，因为样式表要从根选择器命中宿主的 `.app`。
 *
 * 用 `useLayoutEffect` 而不是 `useEffect`：后者在首帧绘制**之后**才跑。
 * 真正的“打开就闪画布”由 hostCanvasCurtain 在模块求值阶段处理，这里只负责跟随路由切换。
 */
function HostCanvasCurtain() {
  const { pathname } = useLocation();
  const inShell = pathname !== ROUTES.create;
  useLayoutEffect(() => {
    setHostCanvasHidden(inShell);
    return () => {
      // 只有在四喜界面模式下卸载时才保持隐藏（例如主题切换、热重载）。
      // 画布态（inShell=false）卸载意味着宿主正进入 node-focus 工作区：
      // 此时不能重新盖住 .app，否则 model workspace 也会消失。
      if (inShell) setHostCanvasHidden(true);
    };
  }, [inShell]);
  return null;
}

/**
 * 宿主画布配色跟随四喜的亮 / 暗（映射见 hostTheme.ts）。
 *
 * 双向：四喜切主题 → 宿主选 `sixi-*` preset；宿主设置里点「浅色 / 暗色」→ 四喜跟着切。
 * 两个方向都以"id 已一致就不动"收敛，不会互相触发成环。
 *
 * **不覆盖宿主自己的 `default` / `dark`**：那是进程级主题，宿主设置和别的扩展都在读
 * （见 hostTheme.ts 文件头）。挂载时记下原本选中的 id，卸载时原样选回去。
 */
function HostThemeSync({ theme }: { theme: ThemeService }) {
  const themeMode = useUiStore((s) => s.themeMode);

  // 挂载时宿主停在哪个 preset；卸载要回到它。用 ref 而不是 effect 依赖，只记一次。
  const restoreRef = useRef<string | null>(null);
  if (restoreRef.current === null) restoreRef.current = theme.getSnapshot().id;

  // layout 阶段：与 ThemeVars 同一时机，四喜外壳与画布在同一帧换色。
  useLayoutEffect(() => {
    theme.registerPreset(HOST_PRESET_ID.light, sixiHostPreset('light'));
    theme.registerPreset(HOST_PRESET_ID.dark, sixiHostPreset('dark'));
    const result = theme.select(HOST_PRESET_ID[themeMode]);
    /*
     * 失败时画布会停在上一套配色、而四喜界面已经换了 —— 正是这次要修的症状。不静默吞掉：
     * 宿主校验整份 preset，任何 token 不合法都会整体拒绝，此时只能说清楚是哪一档没生效。
     */
    if (!result.ok) {
      console.warn(`[sixi-spike] 宿主主题切换失败（${themeMode}）：${result.error}`);
    }
  }, [theme, themeMode]);

  useEffect(
    () =>
      theme.subscribe(() => {
        const mode = modeOfHostPreset(theme.getSnapshot().id);
        const ui = useUiStore.getState();
        if (mode && mode !== ui.themeMode) ui.setThemeMode(mode);
      }),
    [theme],
  );

  useEffect(
    () => () => {
      // 选回挂载前那个 preset —— 宿主内置的或别的扩展注册的，原样放回。
      const restore = restoreRef.current ?? 'default';
      const result = theme.select(restore);
      if (!result.ok) {
        // 那个 preset 已经不在了（例如注册它的扩展先卸载了），退回宿主默认。
        theme.select('default');
      }
    },
    [theme],
  );

  return null;
}

/**
 * 外壳重挂后要落在哪个路由。
 *
 * 点项目卡打开**另一张**画布是一次整页跳转（见 `HostProjectSource`），外壳会在新页面上重新挂载，
 * MemoryRouter 回到初始位置（首页）。用户点的是"进这张画布"，落回首页就等于没反应。
 * 所以跳转前记一笔，新外壳挂载时读走。
 *
 * 同一原因也适用于 sixi shell 因宿主画布进入 node-focus 工作区而被卸载、退出后重挂的情况：
 * 重挂时也要落回原来那个路由（通常是 ROUTES.create），不能落回首页弹出四喜界面。
 * 这里同时维护两个 key：
 * - PENDING_ENTRY_KEY：整页跳转前写入，挂载后清除（一次性）
 * - CURRENT_ROUTE_KEY：路由变化时持续同步，供 remount 时读取；挂载后**不清除**
 *
 * 用 sessionStorage：整页跳转后模块变量不在了；只活在这个标签页里，换标签或关掉就丢，正合适。
 */
const PENDING_ENTRY_KEY = 'sixi-spike.entry';
const CURRENT_ROUTE_KEY = 'sixi-spike.current-route';

function readPendingEntry(): string | null {
  try {
    return sessionStorage.getItem(PENDING_ENTRY_KEY);
  } catch {
    return null;
  }
}

function writePendingEntry(entry: string | null): void {
  try {
    if (entry) sessionStorage.setItem(PENDING_ENTRY_KEY, entry);
    else sessionStorage.removeItem(PENDING_ENTRY_KEY);
  } catch {
    /* 存储不可用：落回首页，不影响跳转本身 */
  }
}

function readCurrentRoute(): string | null {
  try {
    return sessionStorage.getItem(CURRENT_ROUTE_KEY);
  } catch {
    return null;
  }
}

function writeCurrentRoute(route: string): void {
  try {
    sessionStorage.setItem(CURRENT_ROUTE_KEY, route);
  } catch {
    /* 存储不可用：忽略 */
  }
}

export function SixiShell({
  theme,
  canvasCatalog,
  currentCanvasId,
}: {
  theme: ThemeService;
  /** 宿主画布目录；四喜的「项目」就是它（见 app/hostProjectSource.ts）。 */
  canvasCatalog?: CanvasCatalogService;
  /** 当前打开的画布 id；点的就是它时不必切 scope，直接进画布态。 */
  currentCanvasId: () => string | null;
}) {
  // 只在首次渲染读一次；pending 清除放在 effect 里，避免渲染期副作用。
  // 优先 pendingEntry（整页跳转场景），其次 currentRoute（node-focus 卸载后 remount 场景），
  // 最后才落回首页。
  const [initialEntry] = useState(() => readPendingEntry() ?? readCurrentRoute() ?? ROUTES.home);
  useEffect(() => {
    writePendingEntry(null);
  }, []);

  return (
    <SixiProviders>
      <HostThemeSync theme={theme} />
      <MemoryRouter initialEntries={[initialEntry]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        {/* 放在 Router 里：打开当前画布时要用四喜自己的 navigate 切到画布态 */}
        <HostProjectSource catalog={canvasCatalog} currentCanvasId={currentCanvasId} />
        <HostCanvasCurtain />
        {/* 持续同步当前路由，供 shell 被卸载后 remount 时恢复位置（如 node-focus 卸载场景）。 */}
        <RouteSync />
        <Routes>
          {/* 画布态单独一条：不套 AppLayout，四喜的侧栏与顶栏因此完全撤走。 */}
          <Route path={ROUTES.create} element={<CanvasMode />} />
        </Routes>
        <ShellHost />
      </MemoryRouter>
    </SixiProviders>
  );
}

/**
 * 把宿主的画布目录接成四喜的「项目」数据源。
 *
 * 用 effect 而不是在模块顶层设置：卸载时要复位，否则扩展热重载后四喜会拿着上一份
 * 已经失效的 catalog 继续读（表现为列表一直空着、也不报错）。
 */
function HostProjectSource({
  catalog,
  currentCanvasId,
}: {
  catalog?: CanvasCatalogService;
  currentCanvasId: () => string | null;
}) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!catalog) return;
    const open = (canvasId: string) => {
      // 就是当前这张：不用跳页，四喜自己切到画布态即可
      if (canvasId === currentCanvasId()) {
        navigate(ROUTES.create);
        return;
      }
      /*
       * 别的画布：**整页跳转**，不用 `appRouter.navigate` 做页内切换。
       *
       * 实测页内切换（宿主画布切换器同一个入口）后新画布的 Canvas page scope 没能起来：
       * 地址里的 canvasId 变了，页面却整块空白（连宿主 `.app` 都没有），四喜外壳也就没机会重挂；
       * 而同一个地址整页打开每次都正常。跳转前记下落点，新页面上外壳直接进画布态。
       * 宿主侧的这个问题未查明（测试环境无 GPU，不排除是它引起的），查清后可以改回页内切换。
       */
      writePendingEntry(ROUTES.create);
      window.location.assign(`${resolvePublicUrl('/')}?canvasId=${encodeURIComponent(canvasId)}`);
    };
    const reset = setProjectSource(createHostProjectSource(catalog, open));
    return reset;
  }, [catalog, currentCanvasId, navigate]);
  return null;
}

/**
 * 持续把当前路由同步到 sessionStorage，供 shell 被卸载后重挂时恢复位置。
 *
 * 宿主进入 node-focus 工作区时 `canvas.overlay` 的贡献（含 sixi shell）会被卸载；
 * 退出聚焦后重挂，MemoryRouter 会重新走 `initialEntry`，如果不记录当前路由就会落回首页。
 * RouteSync 在每次路由变化时写入 sessionStorage，remount 时 `SixiShell` 读走并作为
 * `initialEntry`，于是恢复到离开前的位置（通常是 ROUTES.create）。
 */
function RouteSync() {
  const { pathname } = useLocation();
  useEffect(() => {
    writeCurrentRoute(pathname);
  }, [pathname]);
  return null;
}

/**
 * 四喜界面容器。
 *
 * **画布态下必须整个不渲染**：这个 div 是 `position: fixed; inset: 0` + 不透明底色，
 * 留在 DOM 里会盖住宿主的画布，连点击一起吞掉（实测现象：点「创作」像没反应）。
 * 不能只靠子路由渲染空内容 —— 空的定层容器照样挡事件。
 */
function ShellHost() {
  const { pathname } = useLocation();
  if (pathname === ROUTES.create) return null;
  return (
    <div className="sixi-host-root">
      <SixiRoutes exclude={[ROUTES.create]} />
    </div>
  );
}
