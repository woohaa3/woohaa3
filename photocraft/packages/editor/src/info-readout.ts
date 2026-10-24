export type InfoReadout={rgb:[number,number,number]|null;cmyk:[number,number,number,number]|null;position:[number,number]|null;selectionSize:[number,number]|null;documentSize:[number,number]};
export type InfoRequest={x:number|null;y:number|null;size:number};
export function decodeInfoReadout(value:unknown):InfoReadout {
  if(!value||typeof value!=="object")throw new Error("信息读数无效");const data=value as Record<string,unknown>;
  const tuple=(key:string,length:number,nullable:boolean,min=-Infinity,max=Infinity,integer=false)=>{const value=data[key];if(nullable&&value===null)return null;if(!Array.isArray(value)||value.length!==length||value.some(value=>typeof value!=="number"||!Number.isFinite(value)||value<min||value>max||integer&&!Number.isSafeInteger(value)))throw new Error("信息读数无效");return [...value];};
  return {rgb:tuple("rgb",3,true,0,255,true),cmyk:tuple("cmyk",4,true,0,100,true),position:tuple("position",2,true),selectionSize:tuple("selectionSize",2,true,1,Infinity,true),documentSize:tuple("documentSize",2,false,1,Infinity,true)} as InfoReadout;
}
