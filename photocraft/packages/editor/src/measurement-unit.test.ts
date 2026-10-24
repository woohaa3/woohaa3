import {expect,it} from "vitest";
import {formatMeasurement,measurementValue,normalizeMeasurementUnit} from "./measurement-unit.js";
it("matches native physical factors, per-axis percent extents, precision and point standards",()=>{
  expect(formatMeasurement(300,"inches",300,900)).toBe("1 in");expect(formatMeasurement(300,"centimeters",300,900)).toBe("2.54 cm");expect(formatMeasurement(300,"millimeters",300,900)).toBe("25.4 mm");
  expect(formatMeasurement(300,"points",300,900)).toBe("72 pt");expect(formatMeasurement(300,"points",300,900,72.27)).toBe("72.3 pt");expect(formatMeasurement(300,"picas",300,900,72.27)).toBe("6.02 pica");
  expect(formatMeasurement(300,"percent",300,1200)).toBe("25 %");expect(formatMeasurement(300,"percent",300,600)).toBe("50 %");expect(formatMeasurement(-0.01,"pixels",300,600)).toBe("0 px");
  expect(measurementValue(300,"centimeters",300,900)).toBeCloseTo(2.54);expect(normalizeMeasurementUnit("inches")).toBe("inches");for(const bad of [null,"cm",true,{},"unknown"])expect(normalizeMeasurementUnit(bad)).toBe("pixels");
});
