import type { RelightRenderMode } from './lab-settings.js';

export type RelightDebugView = RelightRenderMode;
export type RelightLightPreset = 'custom' | 'front' | 'front-left' | 'left' | 'back-left'
  | 'back' | 'back-right' | 'right' | 'front-right' | 'top' | 'hard-backlight'
  | 'low-ambient-stress-test' | 'backlight-stress';

export interface RelightDirectionalSettings {
  azimuth: number;
  elevation: number;
  intensity: number;
  color: string;
  autoScan: boolean;
  paused: boolean;
  reverse: boolean;
  scanSpeed: number;
}
export interface RelightPointSettings {
  enabled: boolean;
  azimuth: number;
  radius: number;
  height: number;
  intensity: number;
  color: string;
  distance: number;
  decay: number;
  orbit: boolean;
  reverse: boolean;
  orbitSpeed: number;
}
export interface RelightHemisphereSettings {
  skyColor: string;
  groundColor: string;
  intensity: number;
}
export interface RelightLightingSettings {
  enabled: boolean;
  exposure: number;
  view: RelightDebugView;
  splitView: boolean;
  splitPosition: number;
  showHelpers: boolean;
  preset: RelightLightPreset;
  directional: RelightDirectionalSettings;
  point: RelightPointSettings;
  hemisphere: RelightHemisphereSettings;
  directionalStartedAt: number;
  pointStartedAt: number;
}
export interface ResolvedRelightLighting {
  view: RelightDebugView;
  exposure: number;
  splitView: boolean;
  splitPosition: number;
  showHelpers: boolean;
  directional: { directionView: readonly [number, number, number]; intensity: number; color: string };
  point: {
    enabled: boolean;
    positionView: readonly [number, number, number];
    intensity: number;
    color: string;
    distance: number;
    decay: number;
  };
  hemisphere: RelightHemisphereSettings;
}

export const RELIGHT_LIGHTING_DEFAULTS: Readonly<RelightLightingSettings> = {
  enabled: true,
  exposure: 1.18,
  view: 'original-unlit',
  splitView: false,
  splitPosition: .5,
  showHelpers: true,
  preset: 'custom',
  directional: { azimuth: 0, elevation: 35, intensity: 2, color: '#ffffff', autoScan: true,
    paused: false, reverse: false, scanSpeed: 30 },
  point: { enabled: false, azimuth: 35, radius: 4, height: 2, intensity: 18, color: '#ffb36b', distance: 10, decay: 2,
    orbit: false, reverse: false, orbitSpeed: 24 },
  hemisphere: { skyColor: '#7f91b5', groundColor: '#242018', intensity: .25 },
  directionalStartedAt: 0,
  pointStartedAt: 0,
};

export const RELIGHT_LIGHT_PRESETS: Readonly<Record<Exclude<RelightLightPreset, 'custom'>,
  Pick<RelightDirectionalSettings, 'azimuth' | 'elevation' | 'intensity'> & { hemisphere?: number }>> = {
  front: { azimuth: 0, elevation: 25, intensity: 2 },
  'front-left': { azimuth: 315, elevation: 25, intensity: 2 },
  left: { azimuth: 270, elevation: 20, intensity: 2 },
  'back-left': { azimuth: 225, elevation: 20, intensity: 2 },
  back: { azimuth: 180, elevation: 20, intensity: 2.4 },
  'back-right': { azimuth: 135, elevation: 20, intensity: 2 },
  right: { azimuth: 90, elevation: 20, intensity: 2 },
  'front-right': { azimuth: 45, elevation: 25, intensity: 2 },
  top: { azimuth: 0, elevation: 90, intensity: 2.2 },
  'hard-backlight': { azimuth: 180, elevation: 12, intensity: 3, hemisphere: .08 },
  'low-ambient-stress-test': { azimuth: 70, elevation: 18, intensity: 2.6, hemisphere: .03 },
  'backlight-stress': { azimuth: 180, elevation: 8, intensity: 3, hemisphere: .08 },
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
const degrees = (value: number): number => value * Math.PI / 180;
const wrapDegrees = (value: number): number => ((value % 360) + 360) % 360;

export function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

export function lightDirectionView(azimuth: number, elevation: number): readonly [number, number, number] {
  const azimuthRadians = degrees(wrapDegrees(azimuth));
  const elevationRadians = degrees(clamp(elevation, -90, 90));
  const horizontal = Math.cos(elevationRadians);
  return [Math.sin(azimuthRadians) * horizontal, Math.sin(elevationRadians), Math.cos(azimuthRadians) * horizontal];
}

function animatedAzimuth(base: number, isMoving: boolean, speed: number, startedAt: number, now: number): number {
  if (!isMoving) return base;
  return wrapDegrees(base + (now - startedAt) / 1000 * speed);
}

export function relightAzimuths(settings: RelightLightingSettings, now = Date.now()): {
  directional: number; point: number;
} {
  return {
    directional: animatedAzimuth(settings.directional.azimuth,
      settings.directional.autoScan && !settings.directional.paused,
      settings.directional.scanSpeed * (settings.directional.reverse ? -1 : 1), settings.directionalStartedAt, now),
    point: animatedAzimuth(settings.point.azimuth, settings.point.orbit && settings.point.enabled,
      settings.point.orbitSpeed * (settings.point.reverse ? -1 : 1), settings.pointStartedAt, now),
  };
}

export function resolveRelightLighting(settings: RelightLightingSettings, now = Date.now()): ResolvedRelightLighting {
  const azimuths = relightAzimuths(settings, now);
  const pointRadians = degrees(azimuths.point);
  return {
    view: settings.view,
    exposure: clamp(settings.exposure, .1, 3),
    splitView: settings.splitView,
    splitPosition: clamp(settings.splitPosition, 0, 1),
    showHelpers: settings.showHelpers,
    directional: { directionView: lightDirectionView(azimuths.directional, settings.directional.elevation),
      intensity: settings.directional.intensity, color: settings.directional.color },
    point: {
      enabled: settings.point.enabled,
      positionView: [Math.sin(pointRadians) * settings.point.radius, settings.point.height,
        Math.cos(pointRadians) * settings.point.radius],
      intensity: settings.point.intensity,
      color: settings.point.color,
      distance: settings.point.distance,
      decay: settings.point.decay,
    },
    hemisphere: settings.hemisphere,
  };
}
