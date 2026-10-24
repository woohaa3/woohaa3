import {FontMenuSample,type FontPreviewSize,type FontSampleReader} from "./font-menu-sample.js";
import {useEffect,useRef,useState} from "react";
import {Button} from "./ui/Button.js";
import {DropdownMenu,MenuEntry} from "./ui/Menu.js";
import {ChevronDownIcon} from "./ui/icons.js";
import {EDITOR_FONT_FAMILIES,fontMenuFamilies,recentFonts,useRecentFonts,type EditorFontFamily as Family} from "./recent-fonts.js";
export {EDITOR_FONT_FAMILIES} from "./recent-fonts.js";
/** A closed picker consumes wheel notches itself, independently of native select behavior. */
export function FontFamilyPicker({value,disabled,onChange,onPreview,english=true,recentLimit=10,fontPreview="medium",readSample}:{fontPreview?:FontPreviewSize;readSample?:FontSampleReader;english?:boolean;recentLimit?:number;value:Family;disabled:boolean;onChange:(font:Family)=>void;onPreview?:(font:Family|null)=>void}) {
 const recent=useRecentFonts();
 const label=(family:Family,name:string)=><span className="photo-editor__font-row"><span>{name}</span><FontMenuSample key={`${family}:${fontPreview}`} family={family} preview={fontPreview} read={readSample}/></span>;
 const [query,setQuery]=useState("");
 useEffect(()=>{recentFonts.limit(recentLimit);},[recentLimit]);
 const choose=(font:Family)=>{if(disabled)return;recentFonts.note(font,recentLimit);onChange(font);};
 const families=fontMenuFamilies(english,query);
 const [open,setOpen]=useState(false),host=useRef<HTMLSpanElement>(null),remainder=useRef(0);
 const current=useRef({value,disabled,open,onChange:choose,onPreview,english});current.current={value,disabled,open,onChange:choose,onPreview,english};
 useEffect(()=>()=>current.current.onPreview?.(null),[]);
 useEffect(()=>{if(disabled){setOpen(false);current.current.onPreview?.(null);}},[disabled]);
 useEffect(()=>{
  const element=host.current;if(!element)return;
  const wheel=(event:WheelEvent)=>{
   const state=current.current;if(state.disabled||state.open||!event.deltaY||event.ctrlKey||event.metaKey||event.altKey)return;
   event.preventDefault();event.stopPropagation();const delta=event.deltaY*(event.deltaMode===1?40:event.deltaMode===2?120:1);
   if(Math.sign(delta)!==Math.sign(remainder.current))remainder.current=0;
   remainder.current+=delta;const steps=Math.trunc(remainder.current/40);if(!steps)return;remainder.current-=steps*40;
   const sorted=fontMenuFamilies(state.english,""),index=sorted.findIndex(item=>item.id===state.value),next=sorted[Math.max(0,Math.min(sorted.length-1,index+steps))]!.id;
   if(next!==state.value)state.onChange(next);
  };
  element.addEventListener("wheel",wheel,{passive:false});return()=>element.removeEventListener("wheel",wheel);
 },[]);
 return <span ref={host} className="photo-editor__font-picker" onPointerLeave={()=>{remainder.current=0;}}>
  <DropdownMenu label="字体" open={open} onOpenChange={next=>{remainder.current=0;setOpen(next);if(!next){setQuery("");onPreview?.(null);}}} trigger={<Button size="sm" title="字体；列表关闭时滚轮切换" disabled={disabled}>{english?value:EDITOR_FONT_FAMILIES.find(item=>item.id===value)?.label??value}<ChevronDownIcon size={12}/></Button>}>
    <input className="photo-editor__font-search" type="search" placeholder="搜索字体" value={query} onChange={event=>{onPreview?.(null);setQuery(event.currentTarget.value);}} onKeyDown={event=>{if(event.key!=="Escape")event.stopPropagation();}}/>
    {!query.trim() && recentLimit>0 && recent.length?<><div className="photo-editor__font-group">最近使用</div>{recent.slice(0,recentLimit).map(font=>{
      const family=fontMenuFamilies(english,"").find(item=>item.id===font)!;
      return <MenuEntry key={`recent:${font}`} item={{id:`recent:${font}`,label:label(font,family.display),selected:font===value,disabled,onHover:hovered=>{if(!disabled)onPreview?.(hovered?font:null);},onSelect:()=>choose(font)}}/>;
    })}<div className="photo-editor__font-group">全部字体</div></>:null}
    {families.map(item=><MenuEntry key={item.id} item={{id:item.id,label:label(item.id,item.display),selected:item.id===value,disabled,onHover:hovered=>{if(!disabled)onPreview?.(hovered?item.id:null);},onSelect:()=>choose(item.id)}}/>)}
    {!families.length?<div className="photo-editor__font-group">没有匹配的字体</div>:null}
  </DropdownMenu>
 </span>;
}
