export const MEASUREMENT_UNITS=[{id:"pixels",label:"像素",suffix:"px",decimals:0},{id:"inches",label:"英寸",suffix:"in",decimals:3},{id:"centimeters",label:"厘米",suffix:"cm",decimals:2},{id:"millimeters",label:"毫米",suffix:"mm",decimals:2},{id:"points",label:"点",suffix:"pt",decimals:1},{id:"picas",label:"派卡",suffix:"pica",decimals:2},{id:"percent",label:"百分比",suffix:"%",decimals:1}] as const;
export type MeasurementUnit=typeof MEASUREMENT_UNITS[number]["id"];
export type PointPicaSize=72|72.27;
export function normalizeMeasurementUnit(value:unknown):MeasurementUnit {return MEASUREMENT_UNITS.some(unit=>unit.id===value)?value as MeasurementUnit:"pixels";}
/** Same factors/precision as native prefs::Unit::from_px; display only, no geometry writes. */
export function measurementValue(px:number,unit:MeasurementUnit,dpi:number,extent:number,ppi:PointPicaSize=72):number {
  dpi=Number.isFinite(dpi)&&dpi>0?dpi:72;
  switch(unit){case "inches":return px/dpi;case "centimeters":return px/dpi*2.54;case "millimeters":return px/dpi*25.4;case "points":return px/dpi*ppi;case "picas":return px/dpi*ppi/12;case "percent":return px/Math.max(1e-6,extent)*100;default:return px;}
}
export function formatMeasurement(px:number,unit:MeasurementUnit,dpi:number,extent:number,ppi:PointPicaSize=72):string {
  const spec=MEASUREMENT_UNITS.find(item=>item.id===unit)??MEASUREMENT_UNITS[0];
  const value=measurementValue(px,spec.id,dpi,extent,ppi);return Number.isFinite(value)?`${Number(value.toFixed(spec.decimals))} ${spec.suffix}`:"—";
}
