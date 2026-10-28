import { useState } from "react";
import type { StoryDefault } from "@ladle/react";
import { AudioPlayer, MediaDialog } from "./index.js";
import { Button } from "../primitives/index.js";
import { ComponentStage } from "../test-support/story-stage.js";
const audio = "data:audio/wav;base64,UklGRsQPAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YaAPAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA";
const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="seagreen"/></svg>');
export default { title: "公共 UI/媒体" } satisfies StoryDefault;
export function SourcesAndRecovery() {
  const [preview, showPreview] = useState(true); const [failed, fail] = useState(false); const [visible, show] = useState(true); const [kind, setKind] = useState<"image" | "audio" | "video">("image");
  return <ComponentStage>{record => <>
    <Button onClick={() => { fail(!failed); record("换源"); }}>正常 / 损坏音频</Button>
    <Button onClick={() => { show(!visible); record("卸载"); }}>挂载 / 卸载播放器</Button>
    {visible && <AudioPlayer url={failed ? "data:audio/wav;base64,AAAA" : audio} />}
    <Button onClick={() => setKind("image")}>图片缩放平移</Button><Button onClick={() => setKind("audio")}>音频</Button><Button onClick={() => setKind("video")}>视频不可用</Button>
    <Button onClick={() => { showPreview(true); record("打开预览"); }}>打开预览</Button>
    {preview && <MediaDialog key={kind + String(failed)} instanceId="component-media" title="媒体预览" kind={kind} url={kind === "image" ? image : kind === "audio" ? audio : null} unavailableReason="素材已失效" onClose={() => { record("关闭预览"); showPreview(false); }} />}
  </>}</ComponentStage>;
}

/** 音频生命周期：加载/就绪/播放/暂停/结束/错误重试/换源/卸载都由原生事件驱动。 */
export function AudioLifecycle() {
  const [source, setSource] = useState<"valid" | "broken">("valid");
  const [visible, show] = useState(true);
  const [generation, bump] = useState(0);
  return <ComponentStage>{record => <>
    <div className="showcase__row">
      <Button size="sm" onClick={() => { setSource("valid"); record("换到可解码源"); }}>可解码源</Button>
      <Button size="sm" onClick={() => { setSource("broken"); record("换到损坏源"); }}>损坏源</Button>
      <Button size="sm" onClick={() => { bump(v => v + 1); record("重试（重挂载）"); }}>重试</Button>
      <Button size="sm" onClick={() => { show(v => !v); record(visible ? "卸载播放器" : "挂载播放器"); }}>{visible ? "卸载" : "挂载"}</Button>
    </div>
    {visible ? <AudioPlayer key={`${source}-${generation}`} url={source === "valid" ? audio : "data:audio/wav;base64,AAAA"} /> : <p>播放器已卸载</p>}
    <output>错误态由播放器内文案与重试按钮呈现；卸载后不再更新状态。</output>
  </>}</ComponentStage>;
}

/** 图片查看：0.25–5 倍缩放、滚轮缩放、拖动平移与重置。 */
export function ImageZoomAndPan() {
  const [visible, show] = useState(true);
  return <ComponentStage>{record => <>
    <Button onClick={() => { show(true); record("打开图片"); }}>打开图片预览</Button>
    {visible && <MediaDialog instanceId="component-image-zoom" title="图片缩放和平移" kind="image" url={image} onClose={() => { record("关闭图片"); show(false); }} />}
    <output>放大/缩小/重置按钮与舞台拖动由 MediaDialog 内部持有；切换资产用 key 重置。</output>
  </>}</ComponentStage>;
}

/** 不可用媒体：url 为 null 时只显示诊断，不渲染播放器或舞台。 */
export function UnavailableMedia() {
  const [kind, setKind] = useState<"image" | "video">("video");
  const [visible, show] = useState(true);
  return <ComponentStage>{record => <>
    <div className="showcase__row">
      <Button size="sm" onClick={() => { setKind("video"); show(true); record("视频不可用"); }}>视频不可用</Button>
      <Button size="sm" onClick={() => { setKind("image"); show(true); record("图片不可用"); }}>图片不可用</Button>
      <Button size="sm" onClick={() => { show(false); record("关闭"); }}>关闭</Button>
    </div>
    {visible && <MediaDialog instanceId={`component-unavailable-${kind}`} title={`${kind} 预览`} kind={kind} url={null} unavailableReason="素材文件已失效或读取被拒绝，请重新生成" onClose={() => { record("关闭预览"); show(false); }} />}
    <output>不可用状态不含放大/缩小与拖动入口。</output>
  </>}</ComponentStage>;
}
