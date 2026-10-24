import {forwardRef,useEffect,useImperativeHandle,useRef,useState,type ChangeEvent,type InputHTMLAttributes,type SyntheticEvent} from "react";
import {flushSync} from "react-dom";
import {parseNumericExpression,type NumericUnits} from "./numeric-expression.js";
type Props=Omit<InputHTMLAttributes<HTMLInputElement>,"value"|"defaultValue"|"type">&{value:string|number;units?:NumericUnits;/** Draft owners receive an empty value until an expression is confirmed, preventing stale-candidate commits. */invalidate?:boolean};
const literal=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
export const ArithmeticInput=forwardRef<HTMLInputElement,Props>(function ArithmeticInput({value,units,invalidate=false,onChange,onBlur,onKeyDown,step,min,max,...props},ref){
 const [text,setText]=useState(String(value)),element=useRef<HTMLInputElement>(null),lastSent=useRef(String(value));
 const current=useRef({value,units,invalidate,onChange,onBlur,onKeyDown,step,min,max});current.current={value,units,invalidate,onChange,onBlur,onKeyDown,step,min,max};
 useImperativeHandle(ref,()=>element.current!,[]);
 useEffect(()=>{const incoming=String(value);if(incoming!==lastSent.current){lastSent.current=incoming;setText(incoming);}},[value]);
 useEffect(()=>{if(props.disabled){setText(String(current.current.value));lastSent.current=String(current.current.value);}},[props.disabled]);
 const parsed=()=>parseNumericExpression(text,current.current.units);
 const within=(n:number)=>((current.current.min===undefined||n>=Number(current.current.min))&&(current.current.max===undefined||n<=Number(current.current.max)));
 useEffect(()=>{const n=parsed();element.current?.setCustomValidity(n===null||!within(n)?"请输入有效且在允许范围内的数值或算术表达式":"");},[text,min,max,units]);
 const emit=(event:SyntheticEvent<HTMLInputElement>,next:string)=>{
  const input=event.currentTarget;lastSent.current=next;input.value=next;current.current.onChange?.(event as ChangeEvent<HTMLInputElement>);
 };
 const commit=(event:SyntheticEvent<HTMLInputElement>)=>{const n=parsed();if(n===null||!within(n))return false;const normalized=String(n);flushSync(()=>{setText(normalized);if(lastSent.current!==normalized)emit(event,normalized);});return true;};
 return <input {...props} ref={element} type="text" inputMode="decimal" maxLength={props.maxLength??1024} data-numeric-input="" step={step} min={min} max={max} value={text}
 onChange={event=>{const raw=event.currentTarget.value;setText(raw);const n=parseNumericExpression(raw,units);
  if(literal.test(raw.trim())&&n!==null)emit(event,raw);else if(invalidate)emit(event,"");
 }} onBlur={event=>{if(commit(event))current.current.onBlur?.(event);}}
 onKeyDown={event=>{
  if(event.nativeEvent.isComposing||event.keyCode===229){current.current.onKeyDown?.(event);return;}
  if(event.key==="Enter"){if(!commit(event)){event.preventDefault();event.stopPropagation();return;}}
  if(event.key==="Escape"){setText(String(value));lastSent.current=String(value);}
  if(event.key==="ArrowUp"||event.key==="ArrowDown"){
   event.preventDefault();const base=parsed()??Number(value);if(Number.isFinite(base)){const amount=step===undefined||step==="any"?1:Number(step),n=base+(event.key==="ArrowUp"?1:-1)*amount*(event.shiftKey?10:1);const next=Math.min(max===undefined?Infinity:Number(max),Math.max(min===undefined?-Infinity:Number(min),n));flushSync(()=>{setText(String(next));emit(event,String(next));});}
  }
  current.current.onKeyDown?.(event);
 }}/>;
});
