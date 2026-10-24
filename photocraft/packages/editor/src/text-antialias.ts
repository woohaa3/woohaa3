export const TEXT_ANTIALIAS=[{id:"none",label:"无"},{id:"sharp",label:"锐利"},{id:"crisp",label:"清晰"},{id:"strong",label:"强"},{id:"smooth",label:"平滑"},{id:"windowsLcd",label:"Windows LCD"},{id:"windows",label:"Windows"}] as const;
export type TextAntialias=typeof TEXT_ANTIALIAS[number]["id"];
export function decodeTextAntialias(value:unknown):TextAntialias|undefined{return TEXT_ANTIALIAS.find(mode=>mode.id===value)?.id;}
