import { useCallback, useState, type ReactNode } from "react";
import { Button, SegmentedControl } from "@woohaa3/ui/primitives";
export type Scenario = "ready" | "loading" | "empty" | "error";
export function useRecorder() { const [events, set] = useState<string[]>([]); const record = useCallback((event: string) => set(old => [...old, event]), []); return { record, log: <output data-integration-recorder>{events.length} 次操作：{events.join(" / ")}</output> }; }
export function ScenarioPicker({ value, onChange }: { value: Scenario; onChange(value: Scenario): void }) {
  return <SegmentedControl label="内存场景" value={value} onValueChange={v => onChange(v as Scenario)} options={["ready", "loading", "empty", "error"].map(value => ({ value, label: value }))} />;
}
export function IntegrationStage({ title, children }: { title: string; children: ReactNode }) {
  return <section style={{ minWidth: 0, maxWidth: 1100, padding: 16 }}><h2>{title}</h2>{children}</section>;
}
export function PendingActions({ settle }: { settle(): void }) { return <Button onClick={settle}>完成内存请求</Button>; }
