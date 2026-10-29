import { useRef, useState } from "react";
import type { StoryDefault } from "@ladle/react";
import { CopyField } from "./index.js";
import { Button } from "../primitives/index.js";
import { ComponentStage } from "../test-support/story-stage.js";
export default { title: "公共 UI/复制反馈" } satisfies StoryDefault;

/** 失败后可重试，并在成功/失败之间切换图标与状态文案。 */
export function Recovery() {
  const attempts = useRef(0);
  return <ComponentStage>{record => <CopyField
    label="标识"
    value="node-123"
    copyText={async () => {
      attempts.current += 1;
      record(attempts.current === 1 ? "首次复制失败" : "重试成功");
      return attempts.current > 1;
    }}
  >
    <code>node-123</code>
  </CopyField>}</ComponentStage>;
}

/** 成功路径：复制完成后显示已复制与对勾，短时后回到 idle。 */
export function Success() {
  return <ComponentStage>{record => <CopyField label="连接地址" value="https://example.test/workspace/very-long-connection-address" copyText={async () => { record("复制成功"); return true; }}>
    <code>https://example.test/workspace/very-long-connection-address</code>
  </CopyField>}</ComponentStage>;
}

/** 失败路径：adapter 返回 false 或抛出，均显示复制失败且不改变值。 */
export function Failure() {
  const [mode, setMode] = useState<"reject" | "throw">("reject");
  return <ComponentStage>{record => <>
    <Button size="sm" onClick={() => setMode(mode === "reject" ? "throw" : "reject")}>切换失败方式：{mode}</Button>
    <CopyField label="失败示例" value={"失败值".repeat(20)} copyText={async () => {
      record(mode === "reject" ? "返回 false" : "抛出异常");
      if (mode === "throw") throw new Error("clipboard unavailable");
      return false;
    }}>
      <code>{"失败值".repeat(20)}</code>
    </CopyField>
  </>}</ComponentStage>;
}

/** 换值后旧结果作废；迟到结果不覆盖新值，卸载后不再写状态。 */
export function StaleResults() {
  const [value, setValue] = useState("版本 A");
  const [mounted, setMounted] = useState(true);
  const resolvers = useRef<Array<(ok: boolean) => void>>([]);
  return <ComponentStage>{record => <>
    <div className="showcase__row">
      <Button size="sm" onClick={() => { setValue("版本 B"); record("换值"); }}>换值</Button>
      <Button size="sm" onClick={() => { resolvers.current.shift()?.(true); record("放行最早请求"); }}>放行迟到结果</Button>
      <Button size="sm" onClick={() => { setMounted(v => !v); record(mounted ? "卸载" : "重新挂载"); }}>{mounted ? "卸载" : "重新挂载"}</Button>
    </div>
    {mounted ? <CopyField label="版本" value={value} copyText={() => new Promise<boolean>(resolve => {
      resolvers.current.push(ok => resolve(ok));
      record(`请求复制 ${value}`);
    })}>
      <code>{value} · {"长内容".repeat(30)}</code>
    </CopyField> : <p>已卸载</p>}
  </>}</ComponentStage>;
}
