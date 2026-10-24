import {publishInterfaceAnimations} from "./interface-animations.js";
import {DEFAULT_NOTIFICATIONS,normalizeNotifications,publishNotifications,type NotificationPreferences} from "./notification-preferences.js";
import {EDITOR_PREFERENCES_KEY,publishRememberWorkspaceChanges,publishLargeDocumentTabs,publishNarrowOptionsBar} from "./workspace-layout-memory.js";
import {MEASUREMENT_UNITS,normalizeMeasurementUnit,type MeasurementUnit,type PointPicaSize} from "./measurement-unit.js";
import {FONT_PREVIEWS,normalizeFontPreview,type FontPreviewSize} from "./font-menu-sample.js";
import {publishPasteboard} from "./pasteboard-appearance.js";
import {CANVAS_COLORS,DEFAULT_PASTEBOARD,normalizePasteboard,cyclePasteboard,type Pasteboard} from "./pasteboard.js";
import {DEFAULT_CURSORS,normalizeCursors,type CursorPreferences} from "./brush-cursor.js";
import {GRID_SIZES,GRID_COLORS,DEFAULT_TRANSPARENCY_GRID,normalizeTransparencyGrid,transparencyGridStyle,type TransparencyGrid} from "./transparency-grid.js";
import {ArithmeticInput} from "./arithmetic-input.js";
import {useEffect,useRef,useState} from "react";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
export type EditorPreferences={enableAnimations:boolean;notifications:NotificationPreferences;narrowOptionsBar:boolean;largeDocumentTabs:boolean;rememberWorkspaceChanges:boolean;measurementUnit:MeasurementUnit;pointPicaSize:PointPicaSize;memoryUsageMb:number;fontPreview:FontPreviewSize;enableGestures:boolean;overscroll:boolean;zoomWithScrollWheel:boolean;zoomWithTrackpadPinch:boolean;pasteboard:Pasteboard;cursors:CursorPreferences;showFontNamesInEnglish:boolean;recentFonts:number;transparency:TransparencyGrid;useEscapeToCommit:boolean;showTransformationValues:boolean;useShiftForToolSwitch:boolean;varyBrushHardnessOnHud:boolean;showBoundingBoxWhenDraggingLayer:boolean;previewLayerReorder:boolean;showRulers:boolean;showGrid:boolean;snapToGuides:boolean;snapToGrid:boolean;gridSize:number;historyStates:number;animatedZoom:boolean;zoomClickedPointToCenter:boolean;enableFlickPanning:boolean;useSmartQuotes:boolean;fillNewTextWithPlaceholder:boolean;screenResolution:number};
export const DEFAULT_EDITOR_PREFERENCES:EditorPreferences={enableAnimations:true,notifications:DEFAULT_NOTIFICATIONS,narrowOptionsBar:false,largeDocumentTabs:false,rememberWorkspaceChanges:true,measurementUnit:"pixels",pointPicaSize:72,memoryUsageMb:8192,fontPreview:"medium",enableGestures:true,overscroll:true,zoomWithScrollWheel:false,zoomWithTrackpadPinch:true,pasteboard:DEFAULT_PASTEBOARD,cursors:DEFAULT_CURSORS,showFontNamesInEnglish:true,recentFonts:10,transparency:DEFAULT_TRANSPARENCY_GRID,useEscapeToCommit:true,showTransformationValues:true,useShiftForToolSwitch:true,varyBrushHardnessOnHud:true,showBoundingBoxWhenDraggingLayer:false,previewLayerReorder:true,showRulers:false,showGrid:false,snapToGuides:true,snapToGrid:false,gridSize:100,historyStates:50,animatedZoom:true,zoomClickedPointToCenter:false,enableFlickPanning:true,useSmartQuotes:true,fillNewTextWithPlaceholder:true,screenResolution:72};
const STORAGE_KEY=EDITOR_PREFERENCES_KEY;
export function normalizeEditorPreferences(value:unknown):EditorPreferences {
  const object=value && typeof value==="object"?value as Record<string,unknown>:{};
  const preferences=Object.fromEntries(Object.entries(DEFAULT_EDITOR_PREFERENCES).map(([key,fallback])=>[key,typeof object[key]==="boolean"?object[key]:fallback ])) as EditorPreferences;
  preferences.notifications=normalizeNotifications(object.notifications);
  preferences.recentFonts=typeof object.recentFonts==="number" && Number.isInteger(object.recentFonts) && object.recentFonts>=0 && object.recentFonts<=50?object.recentFonts:10;
  preferences.transparency=normalizeTransparencyGrid(object.transparency);
  preferences.fontPreview=normalizeFontPreview(object.fontPreview);
  preferences.pasteboard=normalizePasteboard(object.pasteboard);
  preferences.cursors=normalizeCursors(object.cursors);
  preferences.memoryUsageMb=typeof object.memoryUsageMb==="number" && Number.isInteger(object.memoryUsageMb) && object.memoryUsageMb>=256 && object.memoryUsageMb<=1048576?object.memoryUsageMb:8192;
  preferences.historyStates=typeof object.historyStates==="number" && Number.isInteger(object.historyStates) && object.historyStates>=1 && object.historyStates<=1000?object.historyStates:50;
  preferences.measurementUnit=normalizeMeasurementUnit(object.measurementUnit);
  preferences.pointPicaSize=object.pointPicaSize===72.27?72.27:72;
  preferences.screenResolution=typeof object.screenResolution==="number" && Number.isFinite(object.screenResolution) && object.screenResolution>=1 && object.screenResolution<=10000?object.screenResolution:72;
  // 网格步长与切片偏好同属本机显示设置：只接受 2–4096 的整数，坏值回到默认。
  preferences.gridSize=typeof object.gridSize==="number" && Number.isInteger(object.gridSize) && object.gridSize>=2 && object.gridSize<=4096?object.gridSize:DEFAULT_EDITOR_PREFERENCES.gridSize;
  return preferences;
}
export function readEditorPreferences():EditorPreferences {
  try {return normalizeEditorPreferences(JSON.parse(localStorage.getItem(STORAGE_KEY)??"null"));}catch {return {...DEFAULT_EDITOR_PREFERENCES};}
}
const PREFERENCE_SECTIONS={interface:"界面",tools:"工具",type:"文字",workspace:"工作区",performance:"性能",cursors:"光标",units:"单位",grid:"透明网格",navigation:"画布导航"} as const;
type PreferenceSection=keyof typeof PREFERENCE_SECTIONS;
const SECTION_KEYS:Record<PreferenceSection,readonly (keyof EditorPreferences)[]>={
 interface:["enableAnimations","notifications"],tools:["showTransformationValues","useShiftForToolSwitch","varyBrushHardnessOnHud","showBoundingBoxWhenDraggingLayer","previewLayerReorder","showRulers","showGrid","snapToGuides","snapToGrid","gridSize"],
 type:["useEscapeToCommit","useSmartQuotes","fillNewTextWithPlaceholder","showFontNamesInEnglish","recentFonts","fontPreview"],workspace:["narrowOptionsBar","largeDocumentTabs","rememberWorkspaceChanges","pasteboard"],performance:["historyStates","memoryUsageMb"],
 cursors:["cursors"],units:["screenResolution","measurementUnit","pointPicaSize"],grid:["transparency"],navigation:["animatedZoom","zoomClickedPointToCenter","enableFlickPanning","enableGestures","overscroll","zoomWithScrollWheel","zoomWithTrackpadPinch"]
};
export function PreferencesDialog({instance,requestClose,initial,apply}:EditorDialogRendererProps & {initial:EditorPreferences;apply:(next:EditorPreferences)=>boolean}) {
  const [next,setNext]=useState(initial),[notificationSeconds,setNotificationSeconds]=useState(String(initial.notifications.seconds)),[history,setHistory]=useState(String(initial.historyStates)),[memory,setMemory]=useState(String(initial.memoryUsageMb)),[screen,setScreen]=useState(String(initial.screenResolution)),[recent,setRecent]=useState(String(initial.recentFonts));
  const [section,setSection]=useState<PreferenceSection|"all">("all"),[search,setSearch]=useState(""),[appliedMessage,setAppliedMessage]=useState(false);
  const query=search.trim().toLocaleLowerCase();
  const visible=(id:PreferenceSection,terms:string)=>query?(PREFERENCE_SECTIONS[id]+terms).toLocaleLowerCase().includes(query):section==="all" || section===id;
  const reset=(id:PreferenceSection|"all")=>{
    const keys=id==="all"?Object.keys(DEFAULT_EDITOR_PREFERENCES) as (keyof EditorPreferences)[]:SECTION_KEYS[id];
    setNext(value=>({...value,...Object.fromEntries(keys.map(key=>[key,DEFAULT_EDITOR_PREFERENCES[key]]))}));setAppliedMessage(false);
    if(keys.includes("notifications"))setNotificationSeconds(String(DEFAULT_NOTIFICATIONS.seconds));
    if(keys.includes("historyStates"))setHistory(String(DEFAULT_EDITOR_PREFERENCES.historyStates));
    if(keys.includes("memoryUsageMb"))setMemory(String(DEFAULT_EDITOR_PREFERENCES.memoryUsageMb));
    if(keys.includes("screenResolution"))setScreen(String(DEFAULT_EDITOR_PREFERENCES.screenResolution));
    if(keys.includes("recentFonts"))setRecent(String(DEFAULT_EDITOR_PREFERENCES.recentFonts));
  };
  const validNotificationSeconds=notificationSeconds.trim()!=="" && Number.isInteger(Number(notificationSeconds)) && Number(notificationSeconds)>=1 && Number(notificationSeconds)<=120;
  const validNotifications=!next.notifications.autoHide || validNotificationSeconds;
  const validMemory=memory.trim()!=="" && Number.isInteger(Number(memory)) && Number(memory)>=256 && Number(memory)<=1048576;
  const validHistory=history.trim()!=="" && Number.isInteger(Number(history)) && Number(history)>=1 && Number(history)<=1000;
  const validRecent=recent.trim()!=="" && Number.isInteger(Number(recent)) && Number(recent)>=0 && Number(recent)<=50;
  const validScreen=screen.trim()!=="" && Number.isFinite(Number(screen)) && Number(screen)>=1 && Number(screen)<=10000;
  const validGrid=Number.isInteger(next.gridSize) && next.gridSize>=2 && next.gridSize<=4096;
  const valid=validHistory && validMemory && validScreen && validRecent && validNotifications && validGrid;
  const confirm=()=>valid && apply({...next,notifications:{...next.notifications,seconds:validNotificationSeconds?Number(notificationSeconds):next.notifications.seconds},memoryUsageMb:Number(memory),recentFonts:Number(recent),historyStates:Number(history),screenResolution:Number(screen)});
  return <DialogContent size="sm" ariaLabel="编辑器偏好设置" instanceId={instance.instanceId}><form className="photo-editor-preferences" onSubmit={event=>{event.preventDefault();if(confirm())requestClose();}}>
    <DialogHeader onClose={requestClose}><DialogTitle>编辑器偏好设置</DialogTitle></DialogHeader><DialogBody>
      <div className="photo-editor-preferences__filter"><label>分区<select data-preference-section value={section} onChange={event=>{setSection(event.currentTarget.value as PreferenceSection|"all");setSearch("");}}><option value="all">全部设置</option>{Object.entries(PREFERENCE_SECTIONS).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><label>搜索设置<input type="search" value={search} onChange={event=>setSearch(event.currentTarget.value)} placeholder="输入设置名称"/></label></div>
      {query?<p>搜索全部分区；清空搜索后返回所选分区。</p>:null}
      {!valid?<p className="dlg__error">请检查历史数量、内存预算、屏幕分辨率、最近字体数量或通知时长。</p>:null}
      {appliedMessage?<p>偏好设置已应用。</p>:null}
      {([["enableAnimations","启用界面动画"],["useEscapeToCommit","文字编辑时按 Escape 提交"],["showTransformationValues","显示拖动尺寸与偏移"],["useShiftForToolSwitch","使用 Shift 切换同组工具"],["varyBrushHardnessOnHud","笔刷拖动时垂直调整硬度（关闭后调整不透明度）"],["showBoundingBoxWhenDraggingLayer","移动图层时仅显示边界，释放后更新图像"],["previewLayerReorder","拖动重排图层时在画布预览合成"],["showRulers","显示标尺（可从标尺拖出参考线）"],["showGrid","显示网格"],["snapToGuides","吸附到参考线"],["snapToGrid","吸附到网格"],["animatedZoom","缩放时平滑过渡"],["zoomClickedPointToCenter","缩放工具将点击位置移到中心"],["enableFlickPanning","允许平移甩动惯性"],["useSmartQuotes","键入文字时使用智能引号"],["fillNewTextWithPlaceholder","新建文字时填入并选中 Lorem Ipsum"],["showFontNamesInEnglish","字体名称显示英文"]] as const).map(([key,label])=><label key={key} hidden={!visible((Object.keys(SECTION_KEYS) as PreferenceSection[]).find(id=>SECTION_KEYS[id].includes(key))!,label)} className="photo-editor__lock-option"><input type="checkbox" checked={next[key]} onChange={event=>{const checked=event.currentTarget.checked;setNext(value=>({...value,[key]:checked}));}}/>{label}</label>)}
      <div data-preference-group="workspace" hidden={!visible("workspace","紧凑工具选项栏 大文档标签 记忆工作区布局变化")}>
      <label className="photo-editor__lock-option"><input type="checkbox" checked={next.narrowOptionsBar} onChange={event=>{const narrowOptionsBar=event.currentTarget.checked;setNext(value=>({...value,narrowOptionsBar}));}}/>紧凑工具选项栏</label>
      <label className="photo-editor__lock-option"><input type="checkbox" checked={next.largeDocumentTabs} onChange={event=>{const largeDocumentTabs=event.currentTarget.checked;setNext(value=>({...value,largeDocumentTabs}));}}/>大文档标签</label>
      <label className="photo-editor__lock-option"><input type="checkbox" checked={next.rememberWorkspaceChanges} onChange={event=>{const rememberWorkspaceChanges=event.currentTarget.checked;setNext(value=>({...value,rememberWorkspaceChanges}));}}/>记忆工作区布局变化</label>
      <p>关闭后仍可调整当前布局；重新打开编辑器时使用默认布局。</p>
      <div data-preference-group="interface" hidden={!visible("interface","通知 自动隐藏 显示时长 秒")}>
      </div>
      <fieldset data-notification-preferences><legend>通知</legend>
        <label><input type="checkbox" checked={next.notifications.autoHide} onChange={event=>{const autoHide=event.currentTarget.checked;setNext(value=>({...value,notifications:{...value.notifications,autoHide}}));}}/>自动隐藏通知</label>
        <label>显示时长（秒）<input type="number" min={1} max={120} step={1} disabled={!next.notifications.autoHide} value={notificationSeconds} onChange={event=>setNotificationSeconds(event.currentTarget.value)}/></label>
      </fieldset>
      <div data-preference-group="grid" hidden={!visible("grid","透明像素网格 尺寸 配色 浅色 深色")}>
      </div>
      <fieldset><legend>透明像素网格</legend>
        <label>尺寸<select value={next.transparency.size} onChange={event=>{const size=event.currentTarget.value as TransparencyGrid["size"];setNext(value=>({...value,transparency:{...value.transparency,size}}));}}>{GRID_SIZES.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>配色<select value={next.transparency.colors} onChange={event=>{const colors=event.currentTarget.value as TransparencyGrid["colors"];setNext(value=>({...value,transparency:{...value.transparency,colors}}));}}>{GRID_COLORS.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        {next.transparency.colors==="custom"?([['light','浅色'],['dark','深色']] as const).map(([key,label])=><label key={key}>{label}<input type="color" value={next.transparency[key]} onChange={event=>{const color=event.currentTarget.value;setNext(value=>({...value,transparency:{...value.transparency,[key]:color}}));}}/></label>):null}
        <div className="photo-editor__transparency-sample" style={transparencyGridStyle(next.transparency)} title="透明像素显示预览"/>
      </fieldset>
      <div data-preference-group="performance" hidden={!visible("performance","保留历史状态 每份文档内存预算 MB")}>
      </div>
      <label>保留历史状态（1–1000）<ArithmeticInput invalidate  min={1} max={1000} step={1} value={history} onChange={event=>setHistory(event.currentTarget.value)}/></label>
      {visible("tools","网格大小")?<label>网格大小（2–4096 px）<ArithmeticInput invalidate min={2} max={4096} step={1} value={String(next.gridSize)}
        onChange={event=>{const value=Number(event.currentTarget.value);if(Number.isInteger(value))setNext(current=>({...current,gridSize:value}));}}/></label>:null}
      <label>每份文档内存预算（MB）<ArithmeticInput invalidate min={256} max={1048576} step={1} value={memory} onChange={event=>setMemory(event.currentTarget.value)}/></label>
      <p>预算包含像素与历史状态；确认降低上限后，会清除超出预算的较早撤销状态。</p>
      <div data-preference-group="units" hidden={!visible("units","屏幕分辨率 PPI 打印尺寸")}>
      </div>
      <label>屏幕分辨率（PPI）<ArithmeticInput invalidate  min={1} max={10000} step="any" value={screen} onChange={event=>setScreen(event.currentTarget.value)}/></label><p>打印尺寸视图按此值与文档 DPI 换算。</p>
      <div data-preference-group="type" hidden={!visible("type","最近字体数量")}>
      </div>
      <label>最近字体数量（0–50）<ArithmeticInput invalidate min={0} max={50} step={1} value={recent} onChange={event=>setRecent(event.currentTarget.value)}/></label>
      <div data-preference-group="cursors" hidden={!visible("cursors","绘画光标 标准工具指针 精确十字 正常笔尖 全尺寸笔尖 笔尖中心显示十字 绘画期间只显示十字 其它工具")}>
      </div>
      <fieldset data-cursor-preferences><legend>光标</legend>
        <label>绘画光标<select value={next.cursors.painting} onChange={event=>{const painting=event.currentTarget.value as CursorPreferences["painting"];setNext(value=>({...value,cursors:{...value.cursors,painting}}));}}><option value="standard">标准工具指针</option><option value="precise">精确十字</option><option value="normalTip">正常笔尖（50%覆盖）</option><option value="fullSizeTip">全尺寸笔尖</option></select></label>
        <label><input type="checkbox" checked={next.cursors.center} onChange={event=>{const center=event.currentTarget.checked;setNext(value=>({...value,cursors:{...value.cursors,center}}));}}/>笔尖中心显示十字</label>
        <label><input type="checkbox" checked={next.cursors.paintingCrosshairOnly} onChange={event=>{const paintingCrosshairOnly=event.currentTarget.checked;setNext(value=>({...value,cursors:{...value.cursors,paintingCrosshairOnly}}));}}/>绘画期间只显示十字</label>
        <label>其它工具<select value={next.cursors.other} onChange={event=>{const other=event.currentTarget.value as CursorPreferences["other"];setNext(value=>({...value,cursors:{...value.cursors,other}}));}}><option value="standard">标准</option><option value="precise">精确十字</option></select></label>
      </fieldset>
      <div data-preference-group="type" hidden={!visible("type","字体菜单样例大小")}>
      </div>
      <label>字体菜单样例大小<select value={next.fontPreview} onChange={event=>{const fontPreview=event.currentTarget.value as FontPreviewSize;setNext(value=>({...value,fontPreview}));}}>{FONT_PREVIEWS.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <div data-preference-group="navigation" hidden={!visible("navigation","允许触屏双指导航 允许移过文档边缘 Overscroll 使用滚轮缩放 Alt 改为平移 允许触控板捏合缩放")}>
      </div>
      <fieldset><legend>画布导航</legend>
        <label><input type="checkbox" checked={next.enableGestures} onChange={event=>{const enableGestures=event.currentTarget.checked;setNext(value=>({...value,enableGestures}));}}/>允许触屏双指导航</label>
        <label><input type="checkbox" checked={next.overscroll} onChange={event=>{const overscroll=event.currentTarget.checked;setNext(value=>({...value,overscroll}));}}/>允许移过文档边缘（Overscroll）</label>
        <label><input type="checkbox" checked={next.zoomWithScrollWheel} onChange={event=>{const zoomWithScrollWheel=event.currentTarget.checked;setNext(value=>({...value,zoomWithScrollWheel}));}}/>使用滚轮缩放（Alt 改为平移）</label>
        <label><input type="checkbox" checked={next.zoomWithTrackpadPinch} onChange={event=>{const zoomWithTrackpadPinch=event.currentTarget.checked;setNext(value=>({...value,zoomWithTrackpadPinch}));}}/>允许触控板捏合缩放</label>
      </fieldset>
      <div data-preference-group="workspace" hidden={!visible("workspace","画布外工作区 背景颜色 自定义颜色 画布边界 默认背景显示点纹")}>
      </div>
      <fieldset data-pasteboard-preferences><legend>画布外工作区</legend>
        <label>背景颜色<select value={next.pasteboard.color} onChange={event=>{const color=event.currentTarget.value as Pasteboard["color"];setNext(value=>({...value,pasteboard:{...value.pasteboard,color}}));}}>{CANVAS_COLORS.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        {next.pasteboard.color==="custom"?<label>自定义颜色<input type="color" value={next.pasteboard.custom} onChange={event=>{const custom=event.currentTarget.value;setNext(value=>({...value,pasteboard:{...value.pasteboard,custom}}));}}/></label>:null}
        <label>画布边界<select value={next.pasteboard.border} onChange={event=>{const border=event.currentTarget.value as Pasteboard["border"];setNext(value=>({...value,pasteboard:{...value.pasteboard,border}}));}}><option value="dropShadow">投影</option><option value="line">线框</option><option value="none">无</option></select></label>
        <label><input type="checkbox" checked={next.pasteboard.dots} onChange={event=>{const dots=event.currentTarget.checked;setNext(value=>({...value,pasteboard:{...value.pasteboard,dots}}));}}/>默认背景显示点纹</label>
      </fieldset>
      <div data-preference-group="units" hidden={!visible("units","测量单位 点与派卡 PostScript 传统")}>
      </div>
      <div data-measurement-preferences="true"><label>测量单位<select value={next.measurementUnit} onChange={event=>{const measurementUnit=normalizeMeasurementUnit(event.currentTarget.value);setNext(value=>({...value,measurementUnit}));}}>{MEASUREMENT_UNITS.map(unit=><option key={unit.id} value={unit.id}>{unit.label}</option>)}</select></label><label>点与派卡<select value={next.pointPicaSize} onChange={event=>{const pointPicaSize=event.currentTarget.value==="72.27"?72.27:72;setNext(value=>({...value,pointPicaSize}));}}><option value="72">PostScript（72 点/英寸）</option><option value="72.27">传统（72.27 点/英寸）</option></select></label></div>
      </div>
    </DialogBody><DialogFooter className="photo-editor-find-replace__actions"><Button type="button" onClick={()=>reset("all")}>恢复默认值</Button><Button type="button" disabled={section==="all" || !!query} onClick={()=>reset(section)}>重置当前分区</Button><Button type="button" onClick={requestClose}>取消</Button><Button type="button" disabled={!valid} onClick={()=>setAppliedMessage(!!confirm())}>应用</Button><Button tone="primary" type="submit" disabled={!valid}>确认</Button></DialogFooter>
  </form></DialogContent>;
}
/** 本机界面偏好不进入工程或撤销历史；对话框复用宿主唯一弹窗栈。 */
export function useEditorPreferences(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,blocked:boolean,error:(message:string|null)=>void) {
  const [value,setValue]=useState(readEditorPreferences);
  const performanceKey=(preferences:EditorPreferences)=>`${preferences.historyStates}:${preferences.memoryUsageMb}`;
  const applyPerformance=(preferences:EditorPreferences)=>{
    if(controller.setPerformancePreferences)return controller.setPerformancePreferences(preferences.historyStates,preferences.memoryUsageMb);
    if(preferences.memoryUsageMb===8192 && controller.setHistoryLimit)return controller.setHistoryLimit(preferences.historyStates);
    return {ok:false as const,code:"capability-disabled",message:"请更新编辑内核以设置性能偏好"};
  };
  const current=useRef({value,blocked,error});current.current={value,blocked,error};
  const instance=useRef<string|null>(null),opening=useRef(false);
  useEffect(()=>{
    if(!dialogs) return;
    const dispose=dialogs.registerDialog("image-editor.preferences",{definition:{singleton:true,size:"sm",editingOwner:()=>opening.current && !current.current.blocked?controller.dialogOwner():null,validatePayload:payload=>payload==null?{ok:true,payload:null}:{ok:false,error:"无效的偏好设置请求"}},renderer:props=><PreferencesDialog {...props} initial={current.current.value} apply={next=>{
      if(current.current.blocked || dialogs.top()?.instanceId!==props.instance.instanceId || instance.current!==props.instance.instanceId) return false;
      const normalized=normalizeEditorPreferences(next);
      if(performanceKey(normalized)!==performanceKey(current.current.value)){const result=applyPerformance(normalized);if(!result.ok){current.current.error(result.message);return false;}}
      applied.current={controller,value:performanceKey(normalized)};
      setValue(normalized);publishPasteboard(normalized.pasteboard);
      try {localStorage.setItem(STORAGE_KEY,JSON.stringify(normalized));current.current.error(null);}catch {current.current.error("偏好已在本次会话生效；浏览器未能保存，下次打开会恢复默认值");}
      publishRememberWorkspaceChanges(normalized.rememberWorkspaceChanges);
      publishLargeDocumentTabs(normalized.largeDocumentTabs);
      publishNarrowOptionsBar(normalized.narrowOptionsBar);
      publishNotifications(normalized.notifications);
      publishInterfaceAnimations(normalized.enableAnimations);
      return true;
    }}/>});
    return ()=>{if(instance.current) dialogs.close(instance.current);instance.current=null;dispose();};
  },[dialogs,controller]);
  useEffect(()=>{if(blocked && instance.current) {dialogs?.close(instance.current);instance.current=null;}},[blocked,dialogs]);
  const applied=useRef<{controller:EditorWorkspaceController;value:string}|null>(null);
  useEffect(()=>{
    if(blocked || !controller.setHistoryLimit && !controller.setPerformancePreferences || applied.current?.controller===controller && applied.current.value===performanceKey(value))return;
    const result=applyPerformance(value);
    if(result.ok)applied.current={controller,value:performanceKey(value)};else current.current.error(result.message);
  },[blocked,controller,value.historyStates,value.memoryUsageMb]);
  const open=()=>{
    if(!dialogs || current.current.blocked || dialogs.isModalActive()) return false;
    opening.current=true;
    try {const result=dialogs.open({dialogId:"image-editor.preferences"});if(!result.ok) {current.current.error(result.error);return false;}instance.current=result.instance.instanceId;return true;}finally{opening.current=false;}
  };
  const cycleCanvasColor=(backward:boolean)=>{
    if(current.current.blocked || dialogs?.isModalActive())return;
    const next={...current.current.value,pasteboard:cyclePasteboard(current.current.value.pasteboard,backward)};
    current.current.value=next;setValue(next);publishPasteboard(next.pasteboard);
    try{localStorage.setItem(STORAGE_KEY,JSON.stringify(next));current.current.error(null);}catch{current.current.error("背景颜色已在本次会话生效；浏览器未能保存");}
  };
  /**
   * 直接切换一个安全的布尔显示偏好（视图菜单用）。
   *
   * 只允许不涉及内核预算与外部服务的字段；仍走与偏好对话框相同的规范化、发布与存储失败提示，
   * 因此不会绕过「确认后才写本机」的既有规则——这些是菜单项，本身就是明确的用户动作。
   */
  const togglePreference=(key:"showRulers"|"showGrid"|"snapToGuides"|"snapToGrid",next:boolean)=>{
    if(current.current.blocked)return false;
    const normalized=normalizeEditorPreferences({...current.current.value,[key]:next});
    current.current.value=normalized;setValue(normalized);
    try{localStorage.setItem(STORAGE_KEY,JSON.stringify(normalized));current.current.error(null);}catch{current.current.error("偏好已在本次会话生效；浏览器未能保存");}
    return true;
  };
  return {value,open,cycleCanvasColor,togglePreference,available:!!dialogs};
}
