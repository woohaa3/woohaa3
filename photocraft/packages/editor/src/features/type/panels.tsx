import { useEffect, useState } from "react";
import { Button } from "../../ui/Button.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import {
  TYPECRAFT_ANTIALIAS_MODES,
  TYPECRAFT_OPEN_TYPE_FEATURES,
  TYPECRAFT_PARAGRAPH_ALIGNS,
  TYPECRAFT_WARP_STYLES,
  buildFindReplaceParams,
  buildFontReplacementMap,
  buildSpellParams,
  buildTypeMaskParams,
  buildWarpParams,
  type TypeCraftAntiAlias,
  type TypeCraftOpenTypeId,
  type TypeCraftParagraphAlign,
  type TypeCraftWarpStyle
} from "./commands.js";

type TypePanelProps = { controller: EditorWorkspaceController; readonly: boolean; layer: number | null; locked?: boolean };

/** OpenType 特性 id → 上游 `style.features` 的 tag（与内核 `params.rs` 的开关表一致）。 */
const OPEN_TYPE_TAGS: Record<Exclude<TypeCraftOpenTypeId, "standardLigatures" | "discretionaryLigatures">, string> = {
  contextualAlternates: "calt",
  swash: "swsh",
  oldstyle: "onum",
  stylisticAlternates: "salt",
  titlingAlternates: "titl",
  ornaments: "ornm",
  ordinals: "ordn",
  fractions: "frac"
};

/** 统一的结果反馈：成功清空消息，失败显示内核原因。 */
function useCommand(controller: EditorWorkspaceController) {
  const [message, setMessage] = useState<string | null>(null);
  const run = (id: string, params: Record<string, unknown> = {}) => {
    const result = controller.features.type.typeCommand(id, params);
    setMessage(result.ok ? null : result.message);
    return result;
  };
  const query = (id: string, params: Record<string, unknown> = {}) => {
    const result = controller.features.type.typeQuery(id, params);
    if (!result.ok) setMessage(result.message);
    return result;
  };
  return { message, run, query };
}

function target(layer: number | null): Record<string, unknown> {
  return layer === null ? {} : { layer };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 行距／字距／字偶距／基线偏移＋完整段落选项（内核 `type.setStyle`）。 */
export function TypographyPanel({ controller, readonly, layer, locked = false }: TypePanelProps) {
  // `leading` 用 `null` 表示「自动行距」：内核里 `leading_pt: None` 就是自动，
  // 而显式写 `0` 会把行高压成 0pt——那既不是「没改」，也会把内容身份改脏。
  // 初值因此是 `null`，用户真的填了数字才写进参数。
  const [values, setValues] = useState<{
    leading: number | null;
    tracking: number;
    baselineShift: number;
    kerning: string;
    kernAt: number;
    kernBy: number;
  }>({
    leading: null,
    tracking: 0,
    baselineShift: 0,
    kerning: "metrics",
    kernAt: 1,
    kernBy: 0
  });
  const [paragraph, setParagraph] = useState({
    align: "left" as TypeCraftParagraphAlign,
    firstLineIndent: 0,
    startIndent: 0,
    endIndent: 0,
    spaceBefore: 0,
    spaceAfter: 0,
    autoLeading: 120,
    direction: "auto",
    hyphenate: false
  });
  const [message, setMessage] = useState<string | null>(null);
  const apply = (patch: Record<string, unknown>) => {
    const result = controller.features.type.applyTypography({ ...patch, ...target(layer) });
    setMessage(result.ok ? null : result.message);
  };
  const disabled = readonly || locked || layer === null;
  return (
    <section className="photo-editor__advanced-group" aria-label="排版" data-typography="true">
      <span className="photo-editor__options-title">排版</span>
      <label>行距<input type="number" step={0.5} placeholder="自动" value={values.leading ?? ""} disabled={disabled} onChange={(event) => setValues((current) => ({ ...current, leading: event.currentTarget.value === "" ? null : Number(event.currentTarget.value) }))} /></label>
      <label>字距<input type="number" step={10} value={values.tracking} disabled={disabled} onChange={(event) => setValues((current) => ({ ...current, tracking: Number(event.currentTarget.value) }))} /></label>
      <label>基线<input type="number" step={0.5} value={values.baselineShift} disabled={disabled} onChange={(event) => setValues((current) => ({ ...current, baselineShift: Number(event.currentTarget.value) }))} /></label>
      <label>
        字偶距
        <select value={values.kerning} disabled={disabled} onChange={(event) => setValues((current) => ({ ...current, kerning: event.currentTarget.value }))}>
          <option value="metrics">度量</option>
          <option value="optical">视觉</option>
          <option value="off">关</option>
        </select>
      </label>
      <Button size="sm" disabled={disabled} onClick={() => {
        // 行距为 `null`（自动）时**不发这个键**：发 `leading:0` 会把行高压成 0pt，
        // 也会把「只是点了应用排版」判成内容变化。
        const patch: Record<string, unknown> = {
          tracking: values.tracking,
          baselineShift: values.baselineShift,
          kerning: values.kerning
        };
        if (values.leading !== null) patch.leading = values.leading;
        apply(patch);
      }}>应用排版</Button>
      <span className="photo-editor__options-title">指定字符对</span>
      <label>第几个字符<input type="number" min={1} step={1} value={values.kernAt} disabled={disabled} onChange={(event) => setValues((current) => ({ ...current, kernAt: Math.max(1, Math.round(Number(event.currentTarget.value))) }))} /></label>
      <label>字偶距增量<input type="number" step={5} value={values.kernBy} disabled={disabled} onChange={(event) => setValues((current) => ({ ...current, kernBy: Number(event.currentTarget.value) }))} /></label>
      <Button size="sm" disabled={disabled} onClick={() => apply({ kernPair: { at: values.kernAt, by: values.kernBy } })}>调整该字符对</Button>
      <span className="photo-editor__options-title">段落</span>
      <label>
        对齐
        <select value={paragraph.align} disabled={disabled} onChange={(event) => setParagraph((current) => ({ ...current, align: event.currentTarget.value as TypeCraftParagraphAlign }))}>
          {TYPECRAFT_PARAGRAPH_ALIGNS.map((align) => <option key={align} value={align}>{align}</option>)}
        </select>
      </label>
      {([["firstLineIndent", "首行缩进"], ["startIndent", "左缩进"], ["endIndent", "右缩进"], ["spaceBefore", "段前"], ["spaceAfter", "段后"]] as const).map(([key, label]) => (
        <label key={key}>{label}<input type="number" step={0.5} value={paragraph[key]} disabled={disabled} onChange={(event) => setParagraph((current) => ({ ...current, [key]: Number(event.currentTarget.value) }))} /></label>
      ))}
      <label>自动行距 %<input type="number" min={1} max={1000} step={5} value={paragraph.autoLeading} disabled={disabled} onChange={(event) => setParagraph((current) => ({ ...current, autoLeading: Number(event.currentTarget.value) }))} /></label>
      <label>
        文字方向
        <select value={paragraph.direction} disabled={disabled} onChange={(event) => setParagraph((current) => ({ ...current, direction: event.currentTarget.value }))}>
          <option value="auto">自动</option>
          <option value="ltr">从左到右</option>
          <option value="rtl">从右到左</option>
        </select>
      </label>
      <label><input type="checkbox" checked={paragraph.hyphenate} disabled={disabled} onChange={(event) => setParagraph((current) => ({ ...current, hyphenate: event.currentTarget.checked }))} />连字符</label>
      <Button size="sm" disabled={disabled} onClick={() => apply(paragraph)}>应用段落</Button>
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

type StyleEntry = { id: number; name: string };
type StyleKind = "characterStyle" | "paragraphStyle";

/** 样式选项面板可改的持久属性（内核 `parse_attrs` 认识的键：字符属性与段落属性）。 */
const STYLE_CHAR_OPTIONS = [
  { key: "size", label: "字号", step: 0.5 },
  { key: "tracking", label: "字距", step: 10 },
  { key: "leading", label: "行距", step: 0.5 }
] as const;
const STYLE_PARA_OPTIONS = [
  { key: "spaceBefore", label: "段前", step: 0.5 },
  { key: "spaceAfter", label: "段后", step: 0.5 },
  { key: "firstLineIndent", label: "首行缩进", step: 0.5 }
] as const;

/** 字符/段落样式库：列表、新建、复制、选项、应用、重定义、重命名、删除、清除覆盖。 */
export function StyleLibraryPanel({ controller, readonly, layer }: TypePanelProps) {
  const { message, run } = useCommand(controller);
  const [kind, setKind] = useState<StyleKind>("characterStyle");
  const [name, setName] = useState("新样式");
  const [rename, setRename] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [styles, setStyles] = useState<StyleEntry[]>([]);
  const [active, setActive] = useState<{ character: number | null; paragraph: number | null }>({ character: null, paragraph: null });
  const [error, setError] = useState<string | null>(null);
  // 样式选项：只发用户真正改过的键，未填的字段不覆盖样式表里的既有值。
  const [options, setOptions] = useState<Record<string, string>>({});
  // 列表是只读投影：在层/类别/文档修订变化后重取，渲染期不发内核调用。
  const revision = controller.snapshot().view.document?.revision ?? 0;
  useEffect(() => {
    const listed = controller.features.type.typeQuery(`type.${kind}.list`, {});
    if (!listed.ok) {
      setError(listed.message);
      setStyles([]);
      return;
    }
    setError(null);
    const value = asRecord(listed.value);
    setStyles(Array.isArray(value.styles) ? (value.styles as StyleEntry[]) : []);
    const current = asRecord(value.current);
    setActive({
      character: typeof current.character === "number" ? current.character : null,
      paragraph: typeof current.paragraph === "number" ? current.paragraph : null
    });
  }, [controller, kind, layer, revision]);
  const activeId = kind === "characterStyle" ? active.character : active.paragraph;
  const disabled = readonly;
  return (
    <section className="photo-editor__advanced-group" aria-label="样式库" data-type-styles="true">
      <span className="photo-editor__options-title">字符与段落样式</span>
      <label>
        类别
        <select value={kind} disabled={disabled} onChange={(event) => {
          // 切换类别会换掉可选属性集合；未提交的选项值必须清掉，否则 `size` 会被发给段落样式而遭拒。
          setKind(event.currentTarget.value as StyleKind);
          setSelected(null);
          setOptions({});
        }}>
          <option value="characterStyle">字符样式</option>
          <option value="paragraphStyle">段落样式</option>
        </select>
      </label>
      <label>
        样式
        <select value={selected ?? activeId ?? ""} disabled={disabled} onChange={(event) => {
          setSelected(event.currentTarget.value === "" ? null : Number(event.currentTarget.value));
          // 选项属于「已选样式」，换目标后旧值不能顺带写给新样式。
          setOptions({});
        }}>
          <option value="">（当前：{activeId ?? "无"}）</option>
          {styles.map((style) => <option key={style.id} value={style.id}>{style.name}</option>)}
        </select>
      </label>
      <Button size="sm" disabled={disabled || (selected ?? activeId) === null} onClick={() => run(`type.${kind}.apply`, { id: selected ?? activeId, ...target(layer) })}>应用</Button>
      <label>新样式名<input value={name} disabled={disabled} onChange={(event) => setName(event.currentTarget.value)} /></label>
      <Button size="sm" disabled={disabled || !name.trim()} onClick={() => {
        // 从当前文字取格式需要文字层；没有文字层时只建立空样式，不能假装读到了格式。
        const applied = run(`type.${kind}.new`, { name: name.trim(), ...(layer === null ? {} : { fromSelection: true, apply: true, layer }) });
        if (applied.ok) setSelected(null);
      }}>{layer === null ? "新建空样式" : "新建并采用当前格式"}</Button>
      <label>重命名为<input value={rename} disabled={disabled} onChange={(event) => setRename(event.currentTarget.value)} /></label>
      <Button size="sm" disabled={disabled || selected === null || !rename.trim()} onClick={() => run(`type.${kind}.rename`, { id: selected, name: rename.trim() })}>重命名</Button>
      <Button size="sm" tone="ghost" disabled={disabled || selected === null} onClick={() => {
        // 复制后列表会多出一条「原名 copy」，选中副本以便继续改名或改选项。
        const copied = run(`type.${kind}.duplicate`, { id: selected });
        const newId = copied.ok ? asRecord(asRecord(copied.value).result).id : undefined;
        if (typeof newId === "number") setSelected(newId);
      }}>复制样式</Button>
      <span className="photo-editor__options-title">样式选项</span>
      {([...(kind === "characterStyle" ? STYLE_CHAR_OPTIONS : []), ...STYLE_PARA_OPTIONS]).map((option) => (
        <label key={option.key}>
          {option.label}
          <input
            type="number"
            step={option.step}
            value={options[option.key] ?? ""}
            placeholder="不改"
            disabled={disabled || selected === null}
            onChange={(event) => setOptions((current) => ({ ...current, [option.key]: event.currentTarget.value }))}
          />
        </label>
      ))}
      <Button size="sm" disabled={disabled || selected === null || !Object.values(options).some((value) => value.trim() !== "")} onClick={() => {
        // 只发填了数字的键：空字段不能当作 0 覆盖样式表，内核也会拒绝空 attrs。
        const attrs: Record<string, number> = {};
        for (const [key, value] of Object.entries(options)) {
          const number = Number(value);
          if (value.trim() !== "" && Number.isFinite(number)) attrs[key] = number;
        }
        if (!Object.keys(attrs).length) return;
        const applied = run(`type.${kind}.set`, { id: selected, attrs });
        if (applied.ok) setOptions({});
      }}>修改样式选项</Button>
      <Button size="sm" disabled={disabled || selected === null || layer === null} onClick={() => run(`type.${kind}.redefine`, { id: selected, ...target(layer) })}>按当前文字重定义</Button>
      <Button size="sm" tone="ghost" disabled={disabled || selected === null} onClick={() => run(`type.${kind}.delete`, { id: selected })}>删除样式</Button>
      <Button size="sm" tone="ghost" disabled={disabled || layer === null} onClick={() => run(`type.${kind}.clearOverride`, target(layer))}>清除覆盖</Button>
      <span className="photo-editor__option-hint">共 {styles.length} 个样式</span>
      {error ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{error}</p> : null}
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

type InfoStyle = { ligatures?: boolean; discretionary_ligatures?: boolean; features?: { tag: string; value: number }[] };

/** OpenType：十个真实特性开关，读当前文字的首个 run 决定选中状态。 */
export function OpenTypePanel({ controller, readonly, layer, locked = false }: TypePanelProps) {
  const { message, run } = useCommand(controller);
  const [style, setStyle] = useState<InfoStyle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revision = controller.snapshot().view.document?.revision ?? 0;
  useEffect(() => {
    if (layer === null) { setStyle(null); setError(null); return; }
    const info = controller.features.type.typeQuery("type.info", { layer });
    if (!info.ok) { setStyle(null); setError(info.message); return; }
    setError(null);
    const runs = asRecord(info.value).runs;
    const first = Array.isArray(runs) ? asRecord(runs[0]) : {};
    setStyle((first.style as InfoStyle | undefined) ?? null);
  }, [controller, layer, revision]);
  const on = (id: TypeCraftOpenTypeId): boolean => {
    if (!style) return false;
    if (id === "standardLigatures") return style.ligatures !== false;
    if (id === "discretionaryLigatures") return style.discretionary_ligatures === true;
    const tag = OPEN_TYPE_TAGS[id];
    return style.features?.some((feature) => feature.tag === tag && feature.value > 0) ?? false;
  };
  return (
    <section className="photo-editor__advanced-group" aria-label="OpenType" data-type-opentype="true">
      <span className="photo-editor__options-title">OpenType</span>
      {TYPECRAFT_OPEN_TYPE_FEATURES.map((feature) => (
        <label key={feature.id}>
          <input
            type="checkbox"
            checked={on(feature.id)}
            disabled={readonly || locked || layer === null}
            onChange={(event) => run(feature.command, { ...target(layer), on: event.currentTarget.checked })}
          />
          {feature.label}
        </label>
      ))}
      {layer === null ? <p className="photo-editor__brush-note">选择文字图层以启用 OpenType。</p> : null}
      {error ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{error}</p> : null}
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

/** 文字外观与转换：抗锯齿、变形、转工作路径/形状、栅格化、点↔段落。 */
export function TextEffectsPanel({ controller, readonly, layer, locked = false }: TypePanelProps) {
  const { message, run } = useCommand(controller);
  const [warp, setWarp] = useState({ style: "arc" as TypeCraftWarpStyle, bend: 50, horizontalDistortion: 0, verticalDistortion: 0 });
  const disabled = readonly || locked || layer === null;
  return (
    <section className="photo-editor__advanced-group" aria-label="文字外观与转换" data-type-effects="true">
      <span className="photo-editor__options-title">抗锯齿</span>
      <label>
        方式
        <select defaultValue="smooth" disabled={disabled} onChange={(event) => run(`type.antiAlias.${event.currentTarget.value as TypeCraftAntiAlias}`, target(layer))}>
          {TYPECRAFT_ANTIALIAS_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
        </select>
      </label>
      <span className="photo-editor__options-title">文字变形</span>
      <label>
        样式
        <select value={warp.style} disabled={disabled} onChange={(event) => setWarp((current) => ({ ...current, style: event.currentTarget.value as TypeCraftWarpStyle }))}>
          {TYPECRAFT_WARP_STYLES.map((style) => <option key={style} value={style}>{style}</option>)}
        </select>
      </label>
      {([["bend", "弯曲"], ["horizontalDistortion", "水平扭曲"], ["verticalDistortion", "垂直扭曲"]] as const).map(([key, label]) => (
        <label key={key}>{label}<input type="number" min={-100} max={100} step={5} value={warp[key]} disabled={disabled} onChange={(event) => setWarp((current) => ({ ...current, [key]: Number(event.currentTarget.value) }))} /></label>
      ))}
      <Button size="sm" disabled={disabled} onClick={() => run("type.warpText", buildWarpParams({ layer, ...warp }))}>应用变形</Button>
      <Button size="sm" tone="ghost" disabled={disabled} onClick={() => run("type.warpText", buildWarpParams({ layer, style: "none" }))}>取消变形</Button>
      <span className="photo-editor__options-title">形状与像素</span>
      <Button size="sm" disabled={disabled} onClick={() => run("type.createWorkPath", target(layer))}>创建工作路径</Button>
      <Button size="sm" disabled={disabled} onClick={() => run("type.convertToShape", target(layer))}>转换为形状</Button>
      <Button size="sm" disabled={disabled} onClick={() => run("type.rasterizeTypeLayer", target(layer))}>栅格化文字</Button>
      <Button size="sm" disabled={disabled} onClick={() => run("type.convertToParagraphText", target(layer))}>转为段落文字</Button>
      <Button size="sm" disabled={disabled} onClick={() => run("type.convertToPointText", target(layer))}>转为点文字</Button>
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}

type Misspelling = { layer: number; start: number; end: number; word: string; suggestions: string[] };

/** 文字蒙版、查找替换、拼写与缺字体（U69）。 */
export function TextToolsPanel({ controller, readonly, layer, locked = false }: TypePanelProps) {
  const { message, run, query } = useCommand(controller);
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [misspellings, setMisspellings] = useState<Misspelling[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [mapping, setMapping] = useState("");
  // 锁定只挡住「改动目标文字层」的入口；查找、拼写与缺字体替换是全文档只读/独立操作。
  const disabled = readonly || locked || layer === null;
  const findParams = (action: "find" | "changeAll") => buildFindReplaceParams({ find, replace, action });
  return (
    <section className="photo-editor__advanced-group" aria-label="文字工具" data-type-tools="true">
      <span className="photo-editor__options-title">文字蒙版</span>
      <Button size="sm" disabled={disabled} onClick={() => {
        const params = buildTypeMaskParams({ layer });
        if (!params) { setResult("请先选择文字图层"); return; }
        const applied = run("type.createSelection", params);
        setResult(applied.ok ? "已按字形建立选区" : null);
      }}>用字形建立选区</Button>
      <Button size="sm" tone="ghost" disabled={disabled} onClick={() => {
        const params = buildTypeMaskParams({ layer, removeLayer: true });
        if (!params) { setResult("请先选择文字图层"); return; }
        const applied = run("type.createSelection", params);
        setResult(applied.ok ? "已建立选区并删除原文字层（可一步撤销）" : null);
      }}>建立选区并删除文字层</Button>
      <span className="photo-editor__options-title">查找与替换</span>
      <label>查找<input value={find} disabled={readonly} onChange={(event) => setFind(event.currentTarget.value)} /></label>
      <label>替换为<input value={replace} disabled={readonly} onChange={(event) => setReplace(event.currentTarget.value)} /></label>
      <Button size="sm" tone="ghost" disabled={readonly || !find} onClick={() => {
        const params = findParams("find");
        if (!params) return;
        const found = query("edit.findAndReplaceText", params);
        const hit = found.ok ? (asRecord(found.value).found as { layer: number; start: number; end: number } | null | undefined) : null;
        setResult(found.ok ? (hit ? `找到：图层 ${hit.layer}，字符 ${hit.start}–${hit.end}` : "没有更多匹配") : null);
      }}>查找下一个</Button>
      <Button size="sm" tone="ghost" disabled={disabled || !find || !replace} onClick={() => {
        // 上游 `change` 只替换**查找光标当前指向**的那一处；光标由「查找下一个」建立。
        // 这里不再先 find，否则会把光标推到下一处、跳过用户刚看到的那一个。
        const params = buildFindReplaceParams({ find, replace, action: "change" });
        if (!params) return;
        const applied = run("edit.findAndReplaceText", params);
        const result = applied.ok ? asRecord(asRecord(applied.value).result) : {};
        const changed = result.changed as { layer: number; start: number; end: number } | null | undefined;
        const next = result.found as { layer: number } | null | undefined;
        setResult(applied.ok ? (changed ? "已替换当前匹配" : next ? `已定位下一处（图层 ${next.layer}），再点一次替换` : "没有可替换的匹配") : null);
      }}>替换当前</Button>
      <Button size="sm" disabled={disabled || !find} onClick={() => {
        const params = findParams("changeAll");
        if (!params) return;
        const applied = run("edit.findAndReplaceText", params);
        const count = applied.ok ? (asRecord(asRecord(applied.value).result).count as number | undefined) : undefined;
        setResult(applied.ok ? `替换 ${count ?? 0} 处` : null);
      }}>全部替换</Button>
      <span className="photo-editor__options-title">拼写（内置英文词典）</span>
      <Button size="sm" tone="ghost" disabled={readonly} onClick={() => {
        const params = buildSpellParams({ action: "list" });
        if (!params) return;
        const listed = query("edit.checkSpelling", params);
        const rows = listed.ok && Array.isArray(asRecord(listed.value).misspellings) ? asRecord(listed.value).misspellings as Misspelling[] : [];
        setMisspellings(rows);
        setResult(listed.ok ? `发现 ${rows.length} 处疑似拼写错误` : null);
      }}>检查拼写</Button>
      {misspellings.length ? (
        <ul className="photo-editor__brush-report">
          {misspellings.slice(0, 20).map((row) => (
            <li key={`${row.layer}-${row.start}-${row.end}`}>
              {row.word}
              {row.suggestions[0] ? <Button size="sm" disabled={disabled} onClick={() => run("edit.checkSpelling", { action: "change", layer: row.layer, start: row.start, end: row.end, word: row.word, replace: row.suggestions[0] })}>改为 {row.suggestions[0]}</Button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <span className="photo-editor__options-title">缺失字体</span>
      {/* 列出缺字体是只读动作，锁定也允许；替换会改写文档里所有文字层，锁定层必须挡住。 */}
      <Button size="sm" tone="ghost" disabled={readonly} onClick={() => {
        const listed = query("type.resolveMissingFonts", {});
        const fonts = listed.ok && Array.isArray(asRecord(listed.value).missing) ? asRecord(listed.value).missing as string[] : [];
        setMissing(fonts);
        setResult(listed.ok ? (fonts.length ? `缺失：${fonts.join("、")}` : "没有缺失字体") : null);
      }}>列出缺失字体</Button>
      <label>替换映射（缺失=已安装，逗号分隔）<input value={mapping} disabled={readonly} placeholder="Missing=Inter" onChange={(event) => setMapping(event.currentTarget.value)} /></label>
      <Button size="sm" disabled={disabled || !missing.length} onClick={() => {
        const entries = mapping.split(",").map((pair) => pair.split("=")).filter((pair) => pair.length === 2).map(([from, to]) => ({ from: from.trim(), to: to.trim() }));
        const map = buildFontReplacementMap(entries.length ? entries : missing.map((from) => ({ from, to: "Inter" })));
        if (!map) { setResult("请填写「缺失字体=已安装字体」"); return; }
        const applied = run("type.resolveMissingFonts", { map });
        const replaced = applied.ok ? (asRecord(asRecord(applied.value).result).replaced as number | undefined) : undefined;
        setResult(applied.ok ? `已替换 ${replaced ?? 0} 个文字层（原文保留）` : null);
      }}>按映射替换</Button>
      <Button size="sm" tone="ghost" disabled={disabled} onClick={() => run("type.replaceAllMissingFonts")}>全部替换为默认字族</Button>
      {locked ? <p className="photo-editor__brush-note" data-type-font-locked="true">字体替换会改写文档里所有文字层，该文字图层全部锁定；解锁后再替换。</p> : null}
      <span className="photo-editor__options-title">可用字体</span>
      <Button size="sm" tone="ghost" disabled={readonly} onClick={() => {
        const listed = query("type.fonts", {});
        const families = listed.ok && Array.isArray(asRecord(listed.value).families) ? asRecord(listed.value).families as string[] : [];
        setResult(listed.ok ? (families.length ? `可用字族：${families.join("、")}` : "内核没有报告字族") : null);
      }}>列出当前字族</Button>
      {result ? <p className="photo-editor__brush-note">{result}</p> : null}
      {message ? <p className="photo-editor__brush-note photo-editor__brush-note--error">{message}</p> : null}
    </section>
  );
}
