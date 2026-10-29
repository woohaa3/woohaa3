import { useState, type ReactNode } from "react";
export function ProductionFixtureHeader({ title, note }: { title: string; note: string }) { return <header><h2>{title}</h2><p>{note}</p></header>; }
export function OperationLogPanel() { return <p>控件值随操作回流；下方计数记录已执行动作。</p>; }
export function ComponentStage({ children }: { children: (record: (event: string) => void) => ReactNode }) {
  const [events, setEvents] = useState<string[]>([]);
  return <section style={{ maxWidth: 860, padding: 20, display: "grid", gap: 16 }}>
    {children(event => setEvents(old => [...old, event]))}
    <output data-ui-recorder>{events.length} 次操作：{events.join(" / ")}</output>
  </section>;
}
