## ADDED Requirements

### Requirement: Web 编辑器 chrome SHALL 对齐 PhotoCraft 原生分区结构

Web 编辑器 SHALL 按 PhotoCraft 原生 UI 的 options bar、toolbar、right dock、panel group/tab 和 status bar 分区组织已开放能力。工具槽位继续以 `toolbar-slots.ts` 为唯一来源；面板和 Tab 以可见能力投影为来源。未开放能力 MUST NOT 产生空按钮、空 Tab 或可执行占位入口。

#### Scenario: 打开编辑器

- **WHEN** 用户打开一个可编辑图像
- **THEN** Web UI 显示与原生顺序一致的选项栏、分段工具栏、右侧面板组和状态栏
- **AND** 工具、Tab 和动作的可见集合只包含当前能力允许的项目

### Requirement: 嵌入编辑器 SHALL 将 chrome 镂空到画布内容矩形外

嵌入模式 SHALL 使用宿主提供的画布内容矩形作为唯一画布承载区域。菜单栏、选项栏、工具栏、右侧 dock 和状态栏可以定位到该矩形外围；编辑器 MUST NOT 为画布再创建一层内容 fit、尺寸分配或背景渲染。画布预览端口收到的内容矩形和 viewport 语义保持稳定。

#### Scenario: 进入嵌入编辑

- **WHEN** 宿主把编辑器挂到 focus workspace
- **THEN** chrome 从画布内容矩形周围向外镂空，画布直接占用宿主矩形
- **AND** chrome 的显示/隐藏或尺寸变化不会触发第二次画布 fit 或改变文档预览身份

### Requirement: 右侧面板 SHALL 使用可折叠的组和 Tab

右侧面板 SHALL 支持原生面板组的可见投影、Tab 切换、折叠、组间尺寸调整和必要的组菜单。组布局和面板偏好 MUST 属于本机工作区状态，不得推进文档修订、历史、内容指纹或保存基线。组没有可见 Tab 时 MUST 隐藏。

#### Scenario: 切换面板 Tab

- **WHEN** 用户在 Color、Navigator、History、Layers 或其他可见组中切换 Tab
- **THEN** 只替换该组的面板内容，其他组、文档选择、画布 viewport 和历史不变

#### Scenario: 调整面板布局

- **WHEN** 用户折叠、拖动或调整面板组高度/宽度
- **THEN** 布局偏好立即生效并按本机策略保存
- **AND** 文档 dirty 状态、修订、撤销历史和工程字节保持不变

### Requirement: Web chrome SHALL 对齐原生密度和状态职责

选项栏、工具栏、面板 Tab、状态栏 SHALL 使用统一的普通/紧凑尺寸 token、间距、分隔线和滚动边界。状态栏 SHALL 按原生职责显示缩放、色彩模式/位深、文档尺寸、图层数、状态和可用任务；Woohaa 保存、错误和字体提示可作为附加状态，但不得覆盖原生信息。

#### Scenario: 在窄尺寸下显示 chrome

- **WHEN** 视口不足以展示全部选项或面板内容
- **THEN** 选项栏和列表按所属区域滚动或折叠，工具槽位顺序和底部固定入口保持不变
- **AND** 不出现横向溢出覆盖画布或不可访问的控件

### Requirement: 顶部菜单 SHALL 投影原生层级与实际可执行操作

Web 菜单 SHALL 按文件、编辑、图像、图层、文字、选择、滤镜、视图、窗口、帮助排序，并对齐原生已开放项的子菜单层级和分组。参数操作 SHALL 打开实际对话框或已有编辑草稿，确认前复核 owner、文档/选择、顶层实例与命令可用性。窗口菜单 SHALL 能重开已关闭面板并激活指定 Tab。命令 JSON MUST 在 WASM 边界解码，menu 路径为空的 allowed 命令仍可供面板使用。

#### Scenario: 从窗口菜单重开画笔设置

- **WHEN** 用户关闭画笔组后选择窗口中的画笔设置
- **THEN** 侧栏和画笔组可见且画笔设置 Tab 激活
- **AND** 不改变文档内容身份、历史或 viewport

#### Scenario: 参数菜单确认前文档已更换

- **WHEN** 调整、图层操作或参考线对话框的归属文档已失效
- **THEN** 旧请求不得提交到新文档

### Requirement: 画笔选项与采样 SHALL 保留原生笔迹语义

预设应用 SHALL 真正加载 native BrushSettings 并回填本地工具参数，存储/更新前同步当前参数；平滑和锁定遵循 native picking 语义。笔迹 SHALL 保留子像素位置、压感、倾角、旋转和时间，间距不得被 UI 固定值覆盖。停留采样 SHALL 仅按 native generator 的只读时间请求继续推进，并在结束或取消后停止；整笔确认只产生一次历史提交。

#### Scenario: 应用预设后绘画

- **WHEN** 用户应用软圆预设并开始下一笔
- **THEN** 下一笔使用加载的尺寸、硬度和动态设置
- **AND** Web 本地选项不会把它还原成之前的画笔

#### Scenario: 原地喷绘后抬笔

- **WHEN** native generator 请求时间推进且笔保持按下
- **THEN** Web 追加带新时间戳的同位置样本
- **AND** 抬笔后停止调度并将整笔提交为一条历史
