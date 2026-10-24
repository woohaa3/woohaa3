/** Bounded arithmetic parser. Never evaluates JavaScript or accepts identifiers as code. */
export type NumericUnit="px"|"pt"|"in"|"cm"|"mm"|"pc"|"%"|"°";
export type NumericUnits={unit:NumericUnit;dpi?:number;pointsPerInch?:number};
export function parseNumericExpression(input:string,units?:NumericUnits):number|null {
 if(input.length>1024)return null;const text=input.replace(/−/g,"-");let at=0,tokens=0;
 const space=()=>{while(/\s/.test(text[at]??"")&&at<text.length)at++;};
 const take=(token:string)=>{space();if(text.startsWith(token,at)){at+=token.length;return true;}return false;};
 const convert=(value:number,typed:string):number=>{
  if(!units)throw new Error();if(typed==="pica")typed="pc";
  if(typed===units.unit)return value;if(typed==="%"||typed==="°"||units.unit==="%"||units.unit==="°")throw new Error();
  const dpi=units.dpi??72,ppi=units.pointsPerInch??72;if(!Number.isFinite(dpi)||dpi<=0||!Number.isFinite(ppi)||ppi<=0)throw new Error();
  const scale:Record<string,number>={px:1,pt:dpi/ppi,in:dpi,cm:dpi/2.54,mm:dpi/25.4,pc:dpi*12/ppi};return value*scale[typed]!/scale[units.unit]!;
 };
 const expression=(minimum:number,depth:number):number=>{
  if(depth>=32||++tokens>512)throw new Error();space();let left:number;
  if(take("+"))left=expression(3,depth+1);else if(take("-"))left=-expression(3,depth+1);
  else if(take("(")){left=expression(0,depth+1);if(!take(")"))throw new Error();}
  else if(take("pi"))left=Math.PI;else if(take("tau"))left=Math.PI*2;
  else {
   space();const match=/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(at));if(!match)throw new Error();at+=match[0].length;left=Number(match[0]);
   space();const unit=/^(pica|px|pt|pc|in|cm|mm|%|°)/.exec(text.slice(at));
   if(unit && (units || unit[0]!=="%")){at+=unit[0].length;left=convert(left,unit[0]);}
  }
  while(true){space();let op="",precedence=0,rightMinimum=0;
   if(text.startsWith("**",at)){op="**";precedence=3;rightMinimum=3;}else {op=text[at]??"";if(op==="+"||op==="-"){precedence=1;rightMinimum=2;}else if(["*","/","%"].includes(op)){precedence=2;rightMinimum=3;}else if(op==="^"){precedence=3;rightMinimum=3;}else break;}
   if(precedence<minimum)break;at+=op.length;const right=expression(rightMinimum,depth+1);
   if((op==="/"||op==="%")&&right===0)throw new Error();
   left=op==="+"?left+right:op==="-"?left-right:op==="*"?left*right:op==="/"?left/right:op==="%"?left%right:Math.pow(left,right);
   if(!Number.isFinite(left))throw new Error();
  }
  if(!Number.isFinite(left))throw new Error();return left;
 };
 try{const value=expression(0,0);space();return at===text.length&&Number.isFinite(value)?value:null;}catch{return null;}
}
