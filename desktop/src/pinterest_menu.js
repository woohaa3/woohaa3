/* Pinterest 窗口的页内右键菜单：「保存到素材库」「发送到画布」。
 *
 * 这个文件由 `pinterest_window.rs` 用 `include_str!` 读入，作为 `initialization_script` 注入。
 * 它跑在**外部网页**（pinterest.com）里，不是宿主前端：
 *   - 没有任何宿主 token 或业务信息，也调不了宿主；
 *   - 与 Rust 的唯一通道是**导航**：导航到哨兵地址，Rust 的 `on_navigation` 识别、取消导航、取参数。
 *
 * 约束（每一条都踩过或会踩到）：
 *   1. 初始化脚本在文档还没解析时就执行，`document.documentElement` 可能为 null。
 *      **所有碰 DOM 的事都放进事件回调里**，不在顶层碰 DOM。
 *   2. 对方是 SPA，页面会反复重绘。菜单节点挂在 `document.documentElement` 下、自己管理，
 *      不插进对方的 React 树，所以不会被对方的重绘冲掉。
 *   3. 脚本必须幂等（`window.__sixiPin` 守卫），否则每次导航叠加一份监听。
 *   4. 只在顶层框架运行：iframe（广告 / 登录组件）里不该出现我们的菜单。
 *   5. 光标下的图要用 `elementsFromPoint` 找：Pinterest 的卡片上盖着透明的链接遮罩，
 *      `event.target` 往往是遮罩而不是 `<img>`。
 *   6. 只认 `*.pinimg.com` 的图。别的图（头像、广告素材）保持原生右键菜单。
 *
 * 这里的逻辑也被 Rust 单测以字符串方式检查（见 `pinterest_window.rs`），改动后要同步。
 */
(function () {
  if (window.top !== window) return;
  if (window.__sixiPin) return;
  window.__sixiPin = true;

  var SENTINEL = "https://sixi-pinterest.invalid/save";
  var MENU_ID = "__sixi-pin-menu";
  var TOAST_ID = "__sixi-pin-toast";

  /** 是不是 pinimg 的图片地址（只看主机名，和 Rust 白名单同一个口径，Rust 那边还会再校验一遍）。 */
  function isPinimg(src) {
    try {
      var url = new URL(src, location.href);
      return url.protocol === "https:" && (url.hostname === "pinimg.com" || /\.pinimg\.com$/.test(url.hostname));
    } catch (e) {
      return false;
    }
  }

  /** 取一张 `<img>` 最合适的地址：`srcset` 里最大的一张，其次 `currentSrc` / `src`。 */
  function bestSource(img) {
    var best = img.currentSrc || img.src || "";
    var srcset = img.getAttribute("srcset");
    if (srcset) {
      var top = 0;
      srcset.split(",").forEach(function (part) {
        var pieces = part.trim().split(/\s+/);
        var weight = parseFloat(pieces[1] || "1");
        if (pieces[0] && weight >= top && isPinimg(pieces[0])) {
          top = weight;
          best = pieces[0];
        }
      });
    }
    return best;
  }

  /** 光标下的 pinimg 图片。没有就返回 null（保持原生右键菜单）。 */
  function imageAt(x, y) {
    var stack = document.elementsFromPoint(x, y);
    for (var i = 0; i < stack.length; i++) {
      var node = stack[i];
      if (node.tagName === "IMG" && isPinimg(bestSource(node))) return node;
    }
    return null;
  }

  /**
   * 去掉 Pinterest 给标题加的无障碍前后缀，并把「没有标题」的占位文案当成空。
   *
   * 真机实测（中文界面首页，整页 pin 链接与图片）：
   *   - alt：几乎都以「其中包括图片：」开头，**10 张里有 8 张清洗后是空的**；
   *   - 链接 aria-label：固定格式「<标题> Pin 图页面」，真名字和占位都是这个格式；
   *   - 占位有两种：「未命名 Pin 图页面」（没标题）、「Instagram Pin 图页面」（来源平台名，不是标题）。
   * 这些文案跟着界面语言走，所以同时覆盖中英文。
   */
  function cleanTitle(text) {
    var cleaned = String(text || "")
      // 前缀：alt 的无障碍说明
      .replace(/^\s*(其中包括图片|其中包含图片|This may contain|Esto puede contener|Ceci peut contenir)\s*[:：]\s*/i, "")
      // 后缀：链接 aria-label 的「xxx Pin 图页面」/ "xxx Pin page"
      .replace(/\s*(Pin\s*图页面|Pin\s*page)\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    return isPlaceholder(cleaned) ? "" : cleaned;
  }

  /** 「没有标题」的占位：看上去像名字，但存下来只会是一排一样的东西。 */
  function isPlaceholder(text) {
    return /^(未命名|无标题|Untitled)$/i.test(text) || /^(Instagram|Pinterest|Facebook|YouTube|TikTok)$/i.test(text);
  }

  /**
   * 标题最长多少字。
   *
   * 真机实测：不少 pin 的链接 aria-label 是**整段描述加一串话题标签**（几百字），
   * 原样存下来会变成一条长到没法看的素材名。素材名只需要能认出来是哪张图。
   * Rust 侧另有 200 字的硬上限，这里是更早、更温和的截断（按字符数，不是字节）。
   */
  var MAX_TITLE = 60;

  function truncate(text, limit) {
    var chars = Array.from(text);
    return chars.length <= limit ? text : chars.slice(0, limit).join("") + "…";
  }

  /** 图片的标题：优先 `alt`，其次所在 pin 链接的 `aria-label` / `title`，最后页面标题。每一级都先清洗再判断是否为空。 */
  function titleOf(img) {
    var candidates = [img.getAttribute("alt")];
    var link = img.closest("a");
    if (link) candidates.push(link.getAttribute("aria-label"), link.getAttribute("title"));
    // 页面标题只在 pin 详情页（/pin/<id>）才描述「这张图」。首页信息流、搜索页、看板页的标题
    // 是「Pinterest」「xxx 看板」之类，拿来当素材名比兜底名还糟 —— 真机实测首页存图就会得到它。
    if (/^\/pin\/\d+/.test(location.pathname)) candidates.push(document.title);
    for (var i = 0; i < candidates.length; i++) {
      var cleaned = cleanTitle(candidates[i]);
      // 截断放在「判断是否为空之后」：先确定这一级确实有标题，再收短
      if (cleaned) return truncate(cleaned, MAX_TITLE);
    }
    return "Pinterest 图片";
  }

  /** 这张图所属的 pin 页面地址（只用于展示「从哪来的」）。 */
  function pageOf(img) {
    var link = img.closest("a[href]");
    try {
      return link ? new URL(link.getAttribute("href"), location.href).href : location.href;
    } catch (e) {
      return location.href;
    }
  }

  function removeMenu() {
    var existing = document.getElementById(MENU_ID);
    if (existing) existing.remove();
  }

  /** 通过导航把请求交给 Rust。Rust 会取消这次导航，所以页面不会真的跳走。 */
  function send(mode, img) {
    var params = new URLSearchParams({
      mode: mode,
      src: bestSource(img),
      title: titleOf(img).slice(0, 200),
      page: pageOf(img).slice(0, 1000)
    });
    window.location.href = SENTINEL + "?" + params.toString();
  }

  function item(label, onClick) {
    var el = document.createElement("div");
    el.setAttribute("role", "menuitem");
    el.tabIndex = -1;
    el.textContent = label;
    el.style.cssText =
      "padding:8px 16px;cursor:pointer;white-space:nowrap;font:14px/1.4 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#111;";
    el.addEventListener("mouseenter", function () { el.style.background = "#f1f1f1"; });
    el.addEventListener("mouseleave", function () { el.style.background = "transparent"; });
    el.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return el;
  }

  function showMenu(x, y, img) {
    removeMenu();
    var menu = document.createElement("div");
    menu.id = MENU_ID;
    menu.setAttribute("role", "menu");
    // 用最大 z-index 压过对方的浮层；不继承对方样式（全部内联）
    menu.style.cssText =
      "position:fixed;z-index:2147483647;min-width:168px;padding:6px 0;background:#fff;color:#111;" +
      "border:1px solid rgba(0,0,0,.12);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.22);";
    menu.appendChild(item("保存到素材库", function () { removeMenu(); send("library", img); }));
    menu.appendChild(item("发送到画布", function () { removeMenu(); send("canvas", img); }));
    document.documentElement.appendChild(menu);

    // 贴着光标，但不能超出窗口
    var box = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - box.width - 4)) + "px";
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - box.height - 4)) + "px";
  }

  /** Rust 回报结果后弹一条提示（Rust 经 `window.__sixiPinToast(...)` 调用）。 */
  window.__sixiPinToast = function (message, ok) {
    var old = document.getElementById(TOAST_ID);
    if (old) old.remove();
    var toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.setAttribute("role", "status");
    toast.textContent = String(message || "");
    toast.style.cssText =
      "position:fixed;z-index:2147483647;left:50%;bottom:28px;transform:translateX(-50%);max-width:70vw;" +
      "padding:10px 18px;border-radius:999px;font:14px/1.4 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;" +
      "color:#fff;background:" + (ok === false ? "#c9302c" : "#111") + ";box-shadow:0 6px 20px rgba(0,0,0,.28);";
    document.documentElement.appendChild(toast);
    setTimeout(function () { toast.remove(); }, ok === false ? 5000 : 2200);
  };

  // 捕获阶段：赶在对方自己的 contextmenu 处理之前。只有光标下确实是 pinimg 图片才接管，
  // 其余位置不 preventDefault，保持原生菜单（复制链接、检查等）。
  document.addEventListener(
    "contextmenu",
    function (event) {
      var img = imageAt(event.clientX, event.clientY);
      if (!img) { removeMenu(); return; }
      event.preventDefault();
      event.stopPropagation();
      showMenu(event.clientX, event.clientY, img);
    },
    true
  );

  // 点别处、滚动、改变窗口大小、按 Esc 都收起菜单
  document.addEventListener("mousedown", function (event) {
    var menu = document.getElementById(MENU_ID);
    if (menu && !menu.contains(event.target)) removeMenu();
  }, true);
  document.addEventListener("keydown", function (event) { if (event.key === "Escape") removeMenu(); }, true);
  window.addEventListener("scroll", removeMenu, true);
  window.addEventListener("resize", removeMenu);
})();
