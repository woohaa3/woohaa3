import { useState } from "react";
import type { StoryDefault } from "@ladle/react";
import { Dialog, AlertDialog } from "./index.js";
import { Button, DialogSurfaceRoot, Popover, SegmentedControl, Switch } from "../primitives/index.js";
import { ComponentStage } from "../test-support/story-stage.js";
export default { title: "公共 UI/Dialog 与 portal" } satisfies StoryDefault;
export function NestedAndRetry() {
  const [open, show] = useState(false); const [confirm, ask] = useState(false); const [failed, fail] = useState(true); const [busy, setBusy] = useState(false); const [popover, pop] = useState(false);
  return <ComponentStage>{record => <>
    <Button onClick={() => { show(true); record("打开"); }}>打开 Dialog</Button>
    <DialogSurfaceRoot open={open} onOpenChange={show} modal={!confirm}>
      {open && <Dialog.Content ariaLabel="独立 Dialog" size="lg"><Dialog.Header onClose={() => show(false)}><Dialog.Title>独立 Dialog</Dialog.Title></Dialog.Header>
        <Dialog.Body><Popover open={popover} onOpenChange={pop} trigger={<Button>同层浮层</Button>}><Button onClick={() => { pop(false); record("浮层动作"); }}>选择</Button></Popover>
          <p>{"长内容可在正文滚动访问。".repeat(100)}</p><Button onClick={() => ask(true)}>嵌套确认</Button></Dialog.Body>
        <Dialog.Footer><Button onClick={() => show(false)}>关闭</Button></Dialog.Footer>
      </Dialog.Content>}
    </DialogSurfaceRoot>
    <DialogSurfaceRoot open={confirm} onOpenChange={ask} modal busy={busy}>
      {confirm && <AlertDialog instanceId="component-confirm" title="确认操作" description="首次失败后保留内容，重试成功关闭" onBusyChange={setBusy} onCancel={() => ask(false)} onConfirm={async () => {
        record("确认"); if (failed) { fail(false); return { ok: false, error: "保存失败，请重试" }; }
        ask(false); return { ok: true };
      }} />}
    </DialogSurfaceRoot>
  </>}</ComponentStage>;
}

/** 结构解剖：Header/Title/Description/Body/Toolbar/Section/MediaWorkspace/Stage/Footer/IconButton。 */
export function Anatomy() {
  const [open, show] = useState(false);
  return <ComponentStage>{record => <>
    <Button onClick={() => { show(true); record("打开结构示例"); }}>打开结构示例</Button>
    <DialogSurfaceRoot open={open} modal onOpenChange={show}>
      {open && <Dialog.Content ariaLabel="Dialog 结构" size="lg">
        <Dialog.Header onClose={() => { show(false); record("关闭"); }}>
          <Dialog.Title>Dialog 结构</Dialog.Title>
          <Dialog.Description>结构部件均由共享 UI 提供，业务只组合内容。</Dialog.Description>
        </Dialog.Header>
        <Dialog.Body>
          <Dialog.Toolbar label="查看控制">
            <Dialog.IconButton label="放大" tooltip="放大" icon={<span aria-hidden="true">＋</span>} onClick={() => record("放大")} />
            <Dialog.IconButton label="删除" tooltip="删除" icon={<span aria-hidden="true">－</span>} disabled onClick={() => record("不应触发")} />
          </Dialog.Toolbar>
          <Dialog.Section><p>Section 分区承载正文；滚动发生在 Body。</p></Dialog.Section>
          <Dialog.MediaWorkspace aside={<p>辅助区：参数与帧列表</p>}>
            <Dialog.Stage label="媒体舞台">
              <div style={{ minHeight: 120, display: "grid", placeItems: "center" }}>Stage 承载媒体内容</div>
            </Dialog.Stage>
          </Dialog.MediaWorkspace>
        </Dialog.Body>
        <Dialog.Footer>
          <Button tone="primary" onClick={() => { show(false); record("确认"); }}>确认</Button>
          <Button tone="ghost" onClick={() => { show(false); record("取消"); }}>取消</Button>
        </Dialog.Footer>
      </Dialog.Content>}
    </DialogSurfaceRoot>
  </>}</ComponentStage>;
}

/** 尺寸与 busy：sm/md/lg/fullscreen 切换；busy 时不可遮罩关闭。 */
export function SizesAndVariants() {
  const [open, show] = useState(false);
  const [size, setSize] = useState<"sm" | "md" | "lg" | "fullscreen">("md");
  const [busy, setBusy] = useState(false);
  return <ComponentStage>{record => <>
    <div className="showcase__row">
      <SegmentedControl label="尺寸" value={size} onValueChange={value => { setSize(value as typeof size); record(`尺寸 ${value}`); }} options={[
        { value: "sm", label: "sm" }, { value: "md", label: "md" }, { value: "lg", label: "lg" }, { value: "fullscreen", label: "fullscreen" }
      ]} />
      <label className="showcase__row"><Switch checked={busy} onCheckedChange={value => { setBusy(value); record(value ? "进入 busy" : "退出 busy"); }} /> busy</label>
      <Button onClick={() => show(true)}>打开尺寸示例</Button>
    </div>
    <DialogSurfaceRoot open={open} modal onOpenChange={next => { if (!next) record("关闭请求"); show(next); }} busy={busy}>
      {open && <Dialog.Content ariaLabel="尺寸示例" size={size} busy={busy} onOverlayClick={() => record("遮罩关闭请求")}>
        <Dialog.Header onClose={() => { show(false); record("关闭"); }}><Dialog.Title>尺寸：{size}</Dialog.Title></Dialog.Header>
        <Dialog.Body><p>busy={String(busy)}；遮罩点击与关闭按钮走同一 close policy。</p></Dialog.Body>
        <Dialog.Footer><Button onClick={() => { show(false); record("完成"); }}>完成</Button></Dialog.Footer>
      </Dialog.Content>}
    </DialogSurfaceRoot>
  </>}</ComponentStage>;
}
