/** sRGB D65 conversions. CMYK is a generic arithmetic conversion, without an ICC profile. */
export type RGB=readonly [number,number,number];
export type HSV=readonly [number,number,number];
export type ColorSpace="RGB"|"HSB"|"Lab"|"CMYK";
export const clampColor=(value:number,min=0,max=1)=>Math.max(min,Math.min(max,value));
export function hexRgb(hex:string):RGB {return [1,3,5].map(at=>parseInt(hex.slice(at,at+2),16)/255) as unknown as RGB;}
export function rgbHex(rgb:RGB):string{return "#"+rgb.map(value=>Math.round(clampColor(value)*255).toString(16).padStart(2,"0")).join("");}
export function rgbHsv([r,g,b]:RGB,previousHue=0):HSV {
 const max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;let hue=previousHue;
 if(delta>0){hue=max===r?((g-b)/delta)%6:max===g?(b-r)/delta+2:(r-g)/delta+4;hue=(hue*60+360)%360;}
 return [hue,max===0?0:delta/max,max];
}
export function hsvRgb([h,s,v]:HSV):RGB {
 const c=v*s,x=c*(1-Math.abs(((h%360+360)%360)/60%2-1)),m=v-c;
 const hue=(h%360+360)%360;const rgb:RGB=hue<60?[c,x,0]:hue<120?[x,c,0]:hue<180?[0,c,x]:hue<240?[0,x,c]:hue<300?[x,0,c]:[c,0,x];
 return rgb.map(value=>value+m) as unknown as RGB;
}
const linear=(value:number)=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4;
const gamma=(value:number)=>value<=.0031308?value*12.92:1.055*value**(1/2.4)-.055;
const labF=(value:number)=>value>(6/29)**3?Math.cbrt(value):value/(3*(6/29)**2)+4/29;
const labInv=(value:number)=>value>6/29?value**3:3*(6/29)**2*(value-4/29);
export function rgbLab(rgb:RGB):RGB {
 const [r,g,b]=rgb.map(linear),x=labF((.4124564*r+.3575761*g+.1804375*b)/.95047),y=labF(.2126729*r+.7151522*g+.072175*b),z=labF((.0193339*r+.119192*g+.9503041*b)/1.08883);
 return [116*y-16,500*(x-y),200*(y-z)];
}
export function labRgb([l,a,b]:RGB):RGB {
 const y=(l+16)/116,x=.95047*labInv(y+a/500),z=1.08883*labInv(y-b/200),yy=labInv(y);
 return [3.2404542*x-1.5371385*yy-.4985314*z,-.969266*x+1.8760108*yy+.041556*z,.0556434*x-.2040259*yy+1.0572252*z].map(gamma) as unknown as RGB;
}
export function nearestWebColor(hex:string):string {return rgbHex(hexRgb(hex).map(channel=>Math.round(channel*5)/5) as unknown as RGB);}
export const SPACE_FIELDS:Record<ColorSpace,readonly {label:string;min:number;max:number}[]>={RGB:[{label:"R",min:0,max:255},{label:"G",min:0,max:255},{label:"B",min:0,max:255}],HSB:[{label:"H（°）",min:0,max:360},{label:"S（%）",min:0,max:100},{label:"B（%）",min:0,max:100}],Lab:[{label:"L",min:0,max:100},{label:"a",min:-128,max:127},{label:"b",min:-128,max:127}],CMYK:[{label:"C（%）",min:0,max:100},{label:"M（%）",min:0,max:100},{label:"Y（%）",min:0,max:100},{label:"K（%）",min:0,max:100}]};
export function colorNumbers(space:ColorSpace,hex:string,hue=0):number[] {
 const rgb=hexRgb(hex);if(space==="RGB")return rgb.map(channel=>channel*255);
 if(space==="HSB"){const [h,s,v]=rgbHsv(rgb,hue);return [h,s*100,v*100];}
 if(space==="Lab")return [...rgbLab(rgb)];
 const k=1-Math.max(...rgb);return [...rgb.map(channel=>k>=1?0:(1-channel-k)/(1-k)),k].map(value=>value*100);
}
export function numbersRgb(space:ColorSpace,values:readonly number[]):RGB {
 const [a,b,c,d]=values;if(space==="RGB")return [a/255,b/255,c/255];if(space==="HSB")return hsvRgb([a,b/100,c/100]);if(space==="Lab")return labRgb([a,b,c]);return [(1-a/100)*(1-d/100),(1-b/100)*(1-d/100),(1-c/100)*(1-d/100)];
}
export function validColorNumbers(space:ColorSpace,values:readonly string[]):boolean{return values.length===SPACE_FIELDS[space].length && values.every((text,index)=>text.trim()!=="" && Number.isFinite(Number(text)) && Number(text)>=SPACE_FIELDS[space][index].min && Number(text)<=SPACE_FIELDS[space][index].max);}
export function normalizeHex(value:string):string|null{const hex=value.trim().replace(/^#/,"");if(/^[0-9a-f]{3}$/i.test(hex))return "#"+[...hex].map(char=>char+char).join("").toLowerCase();return /^[0-9a-f]{6}$/i.test(hex)?"#"+hex.toLowerCase():null;}
