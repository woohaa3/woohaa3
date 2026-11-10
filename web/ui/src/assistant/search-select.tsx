import { useState } from "react";
/** Large enums stay bounded and searchable; selection never dismisses the parent form. */
export function SearchSelect({ label, options, value, onChange, disabled, lockedBy }: {
  label: string; options: readonly { value: string; label: string }[]; value: string;
  onChange(value: string): void; disabled?: boolean; lockedBy?: string;
}) {
  const [query, setQuery] = useState("");
  const selected = options.find(o => o.value === value);
  const filtered = options.filter(o => `${o.label} ${o.value}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="mc-panel__settings-group"><span className="mc-panel__settings-label">{label}{lockedBy ? <small>由「{lockedBy}」决定</small> : null}</span>
    {options.length > 8 ? <input placeholder={`搜索${label}`} value={query} disabled={disabled} onChange={e => setQuery(e.target.value)} /> : null}
    <select className="mc-panel__settings-select" value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
      {!selected ? <option value={value}>{value || "请选择"}</option> : !filtered.includes(selected) ? <option value={value}>{selected.label}</option> : null}
      {filtered.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>{query && !filtered.length ? <small>当前搜索无结果</small> : null}
  </div>;
}
