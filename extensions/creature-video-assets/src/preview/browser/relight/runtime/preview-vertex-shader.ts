// Exception reason: keeping the complete sprite vertex shader in one constant makes Lab parity auditable.
export const RELIGHT_PREVIEW_VERTEX_SHADER = /* glsl */ `
#include <common>
#include <shadowmap_pars_vertex>

uniform sampler2D uMaterialMap;
uniform sampler2D uShadowDepthMap;
uniform vec4 uMaterialRect;
uniform vec4 uMaterialCanvasRect;
uniform vec4 uShadowDepthRect;
uniform vec4 uShadowDepthCanvasRect;
uniform float uHasMaterial;
uniform float uHasShadowDepth;
uniform float uMirrorX;
uniform float uInvertDepth;
uniform float uDepthMin;
uniform float uDepthMax;
uniform float uDepthBias;
uniform float uFrameShadowEnabled;
uniform float uFrameShadowRelief;

varying vec2 vCanvasUv;
varying vec3 vPlanePositionView;

bool vertexOutside(vec2 canvasUv, vec4 canvasRect) {
  return any(lessThan(canvasUv, canvasRect.xy))
    || any(greaterThan(canvasUv, canvasRect.xy + canvasRect.zw));
}

float vertexLayerRed(sampler2D map, vec4 atlasRect, vec4 canvasRect, vec2 canvasUv) {
  vec2 localUv = (canvasUv - canvasRect.xy) / max(canvasRect.zw, vec2(1e-5));
  return texture2D(map, atlasRect.xy + clamp(localUv, 0.0, 1.0) * atlasRect.zw).r;
}

float frameDepth(vec2 canvasUv) {
  if (uHasShadowDepth > 0.5 && !vertexOutside(canvasUv, uShadowDepthCanvasRect)) {
    return vertexLayerRed(uShadowDepthMap, uShadowDepthRect, uShadowDepthCanvasRect, canvasUv);
  }
  if (uHasMaterial > 0.5 && !vertexOutside(canvasUv, uMaterialCanvasRect)) {
    return vertexLayerRed(uMaterialMap, uMaterialRect, uMaterialCanvasRect, canvasUv);
  }
  return 0.5;
}

void main() {
  float mirroredX = mix(uv.x, 1.0 - uv.x, uMirrorX);
  vCanvasUv = vec2(mirroredX, 1.0 - uv.y);
  vec4 planePositionView = modelViewMatrix * vec4(position, 1.0);
  vPlanePositionView = planePositionView.xyz;
  gl_Position = projectionMatrix * planePositionView;

  float sampledDepth = frameDepth(vCanvasUv);
  sampledDepth = mix(sampledDepth, 1.0 - sampledDepth, uInvertDepth) + uDepthBias;
  float depth01 = clamp((sampledDepth - uDepthMin) / max(uDepthMax - uDepthMin, 1e-4), 0.0, 1.0);
  vec3 frameShadowPosition = position;
  frameShadowPosition.z += (depth01 - 0.5) * uFrameShadowRelief * uFrameShadowEnabled;
  vec3 transformedNormal = normalMatrix * normal;
  vec4 worldPosition = modelMatrix * vec4(frameShadowPosition, 1.0);
  #include <shadowmap_vertex>
}
`;
