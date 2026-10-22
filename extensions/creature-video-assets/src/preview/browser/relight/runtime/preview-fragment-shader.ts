// Exception reason: the full Lab BRDF/debug shader stays contiguous so GPU parity remains reviewable.
export const RELIGHT_PREVIEW_FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <packing>

uniform bool receiveShadow;
#include <shadowmap_pars_fragment>

uniform sampler2D uBodyMap;
uniform sampler2D uSurfaceMap;
uniform sampler2D uMaterialMap;
uniform sampler2D uMaskMap;
uniform sampler2D uBaseColorMap;
uniform sampler2D uOriginalBlurMap;
uniform sampler2D uShadowDepthMap;
uniform vec4 uBodyRect, uSurfaceRect, uMaterialRect, uMaskRect;
uniform vec4 uBaseColorRect, uOriginalBlurRect, uShadowDepthRect;
uniform vec4 uBodyCanvasRect, uSurfaceCanvasRect, uMaterialCanvasRect, uMaskCanvasRect;
uniform vec4 uBaseColorCanvasRect, uOriginalBlurCanvasRect, uShadowDepthCanvasRect;
uniform vec3 uNormalScale, uNormalBias, uAppearanceSlope, uAppearanceBias;
uniform vec2 uDeLitRange, uViewport, uSpriteSize;
uniform mat3 uObjectNormalToView;
uniform float uHasMaterial, uHasMask, uHasBaseColor, uHasOriginalBlur, uHasShadowDepth;
uniform float uMaskChannel, uDewhite, uReady, uGbufferEnabled, uLightingEnabled, uMirrorX;
uniform float uBaseColorMode, uDebugView, uUnlit, uSplitView, uSplitPosition;
uniform float uDetailStrength, uDetailMin, uDetailMax, uDeLightStrength;
uniform float uAlbedoGain, uExposureCompensation;
uniform vec3 uAlbedoTint;
uniform float uNormalSpace, uNormalSwizzle;
uniform vec3 uNormalAxisFlip;
uniform float uNormalStrength, uNormalizeNormal;
uniform float uUseRoughnessMap, uRoughnessFallback, uRoughnessScale, uRoughnessBias;
uniform float uRoughnessMin, uRoughnessMax;
uniform float uUseMetallicMap, uMetallicFallback, uMetallicScale, uMetallicBias;
uniform float uMetallicThreshold, uForceNonMetal;
uniform float uWrapDiffuse, uDiffuseWrap, uSpecularEnabled, uSpecularIntensity;
uniform float uRimEnabled, uRimIntensity, uRimPower;
uniform float uDepthPositionEnabled, uInvertDepth, uDepthMin, uDepthMax, uDepthBias;
uniform float uCharacterThickness, uSelfShadowEnabled, uSelfShadowStrength;
uniform float uSelfShadowLength, uSelfShadowBias, uSelfShadowSoftness;
uniform float uFrameShadowEnabled, uFrameShadowStrength, uAlphaTest;
uniform vec3 uDirectionalDirection, uDirectionalColor;
uniform float uDirectionalIntensity;
uniform vec3 uPointPosition, uPointColor;
uniform float uPointEnabled, uPointIntensity, uPointDistance, uPointDecay;
uniform vec3 uHemisphereDirection, uHemisphereSky, uHemisphereGround;
uniform float uHemisphereIntensity;

varying vec2 vCanvasUv;
varying vec3 vPlanePositionView;

vec3 safeNormalize(vec3 value, vec3 fallbackValue) {
  float lengthSquared = dot(value, value);
  return lengthSquared > 1e-10 ? value * inversesqrt(lengthSquared) : fallbackValue;
}

bool outside(vec2 canvasUv, vec4 canvasRect) {
  return any(lessThan(canvasUv, canvasRect.xy))
    || any(greaterThan(canvasUv, canvasRect.xy + canvasRect.zw));
}

vec4 sampleLayer(sampler2D map, vec4 atlasRect, vec4 canvasRect, vec2 canvasUv) {
  vec2 localUv = (canvasUv - canvasRect.xy) / max(canvasRect.zw, vec2(1e-5));
  return texture2D(map, atlasRect.xy + clamp(localUv, 0.0, 1.0) * atlasRect.zw);
}

vec4 optionalLayer(sampler2D map, vec4 atlasRect, vec4 canvasRect, vec2 canvasUv, vec4 fallbackValue) {
  return outside(canvasUv, canvasRect) ? fallbackValue : sampleLayer(map, atlasRect, canvasRect, canvasUv);
}

float selectedChannel(vec4 value, float channel) {
  if (channel < 0.5) return value.r;
  if (channel < 1.5) return value.g;
  if (channel < 2.5) return value.b;
  return value.a;
}

vec3 toSrgb(vec3 color) {
  return mix(color * 12.92, 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - .055,
    step(vec3(.0031308), color));
}

vec3 toLinear(vec3 color) {
  return mix(color / 12.92, pow((color + .055) / 1.055, vec3(2.4)), step(vec3(.04045), color));
}

vec3 dewhite(vec3 linearColor, float alpha) {
  if (uDewhite < .5 || alpha <= .02 || alpha >= .995) return linearColor;
  vec3 color = toSrgb(linearColor);
  vec3 foreground = clamp((color - vec3(1.0 - alpha)) / max(alpha, .12), 0.0, 1.0);
  float weight = .45 * pow(1.0 - alpha, .65) * clamp((alpha - .02) / .18, 0.0, 1.0);
  return toLinear(mix(color, foreground, weight));
}

vec3 swizzleNormal(vec3 value) {
  if (uNormalSwizzle < .5) return value.xyz;
  if (uNormalSwizzle < 1.5) return value.xzy;
  if (uNormalSwizzle < 2.5) return value.yxz;
  if (uNormalSwizzle < 3.5) return value.yzx;
  if (uNormalSwizzle < 4.5) return value.zxy;
  return value.zyx;
}

vec3 decodeNormal(vec3 encoded) {
  vec3 decoded = swizzleNormal(encoded * uNormalScale + uNormalBias) * uNormalAxisFlip;
  decoded.x *= mix(1.0, -1.0, uMirrorX);
  if (uNormalSpace > .5) decoded = uObjectNormalToView * decoded;
  if (uNormalizeNormal > .5) decoded = safeNormalize(decoded, vec3(0.0, 0.0, 1.0));
  vec3 strengthened = mix(vec3(0.0, 0.0, 1.0), decoded, uNormalStrength);
  return uNormalizeNormal > .5 ? safeNormalize(strengthened, vec3(0.0, 0.0, 1.0)) : strengthened;
}

float distributionGGX(vec3 normal, vec3 halfway, float roughness) {
  float alpha = roughness * roughness;
  float alphaSquared = alpha * alpha;
  float normalHalfway = max(dot(normal, halfway), 0.0);
  float denominator = normalHalfway * normalHalfway * (alphaSquared - 1.0) + 1.0;
  return alphaSquared / max(PI * denominator * denominator, 1e-5);
}

float geometryGGX(float normalDirection, float roughness) {
  float k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  return normalDirection / max(normalDirection * (1.0 - k) + k, 1e-5);
}

vec3 evaluateLight(vec3 baseColor, vec3 normal, vec3 direction, vec3 radiance,
  float roughness, float metallic, out vec3 specularContribution) {
  vec3 viewDirection = vec3(0.0, 0.0, 1.0);
  float normalLight = max(dot(normal, direction), 0.0);
  float normalView = max(dot(normal, viewDirection), 1e-4);
  vec3 halfway = safeNormalize(direction + viewDirection, normal);
  float viewHalfway = max(dot(viewDirection, halfway), 0.0);
  vec3 f0 = mix(vec3(.04), clamp(baseColor, 0.0, 1.0), metallic);
  vec3 fresnel = f0 + (vec3(1.0) - f0) * pow(clamp(1.0 - viewHalfway, 0.0, 1.0), 5.0);
  float distribution = distributionGGX(normal, halfway, roughness);
  float geometry = geometryGGX(normalView, roughness) * geometryGGX(normalLight, roughness);
  vec3 specular = distribution * geometry * fresnel / max(4.0 * normalView * normalLight, 1e-4);
  vec3 diffuse = (vec3(1.0) - fresnel) * (1.0 - metallic) * baseColor / PI;
  float wrapped = clamp((dot(normal, direction) + uDiffuseWrap) / (1.0 + uDiffuseWrap), 0.0, 1.0);
  float diffuseResponse = mix(normalLight, wrapped, uWrapDiffuse);
  specularContribution = specular * radiance * normalLight * uSpecularEnabled * uSpecularIntensity;
  return diffuse * radiance * diffuseResponse + specularContribution;
}

float pointAttenuation(float distance) {
  float attenuation = 1.0 / max(pow(max(distance, .01), uPointDecay), .01);
  if (uPointDistance > 0.0) {
    float ratio = distance / uPointDistance;
    float cutoff = clamp(1.0 - ratio * ratio * ratio * ratio, 0.0, 1.0);
    attenuation *= cutoff * cutoff;
  }
  return attenuation;
}

float normalizedDepth(float sampledDepth) {
  sampledDepth = mix(sampledDepth, 1.0 - sampledDepth, uInvertDepth) + uDepthBias;
  return clamp((sampledDepth - uDepthMin) / max(uDepthMax - uDepthMin, 1e-4), 0.0, 1.0);
}

float sampleShadowDepth(vec2 canvasUv, out float sampleAlpha) {
  vec4 body = optionalLayer(uBodyMap, uBodyRect, uBodyCanvasRect, canvasUv, vec4(0.0));
  sampleAlpha = body.a;
  if (uHasMask > .5) sampleAlpha = outside(canvasUv, uMaskCanvasRect) ? 0.0
    : selectedChannel(sampleLayer(uMaskMap, uMaskRect, uMaskCanvasRect, canvasUv), uMaskChannel);
  if (uHasShadowDepth > .5 && !outside(canvasUv, uShadowDepthCanvasRect)) {
    return normalizedDepth(sampleLayer(uShadowDepthMap, uShadowDepthRect, uShadowDepthCanvasRect, canvasUv).r);
  }
  if (uHasMaterial > .5 && !outside(canvasUv, uMaterialCanvasRect)) {
    return normalizedDepth(sampleLayer(uMaterialMap, uMaterialRect, uMaterialCanvasRect, canvasUv).r);
  }
  return .5;
}

float traceSelfShadow(vec2 canvasUv, float currentDepth, vec3 lightDirection) {
  if (uSelfShadowEnabled < .5 || uSelfShadowStrength <= 0.0 || uSelfShadowLength <= 0.0) return 1.0;
  float transverseLength = length(lightDirection.xy);
  if (transverseLength < 1e-4) return 1.0;
  vec2 planeDirection = lightDirection.xy / transverseLength;
  float aspect = max(uSpriteSize.x / max(uSpriteSize.y, 1e-4), 1e-4);
  float depthSlope = lightDirection.z / transverseLength / max(uCharacterThickness, .02);
  float occlusion = 0.0;
  for (int stepIndex = 1; stepIndex <= 24; stepIndex += 1) {
    float progress = float(stepIndex) / 24.0;
    float planeDistance = uSelfShadowLength * progress;
    float mirrorDirection = mix(1.0, -1.0, uMirrorX);
    vec2 sampleUv = canvasUv + vec2(planeDirection.x * mirrorDirection / aspect, -planeDirection.y) * planeDistance;
    if (sampleUv.x <= 0.0 || sampleUv.x >= 1.0 || sampleUv.y <= 0.0 || sampleUv.y >= 1.0) continue;
    float blockerAlpha;
    float blockerDepth = sampleShadowDepth(sampleUv, blockerAlpha);
    float rayDepth = currentDepth + depthSlope * planeDistance;
    float blocker = smoothstep(uSelfShadowBias, uSelfShadowBias + max(uSelfShadowSoftness, 1e-4),
      blockerDepth - rayDepth) * step(uAlphaTest, blockerAlpha);
    occlusion = max(occlusion, blocker * (1.0 - progress * .2));
  }
  return 1.0 - clamp(occlusion * uSelfShadowStrength, 0.0, 1.0);
}

float directionalFrameShadow() {
  float shadow = 1.0;
  #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
    DirectionalLightShadow directionalLight = directionalLightShadows[0];
    shadow = receiveShadow ? getShadow(directionalShadowMap[0], directionalLight.shadowMapSize,
      directionalLight.shadowIntensity, directionalLight.shadowBias, directionalLight.shadowRadius,
      vDirectionalShadowCoord[0]) : 1.0;
  #endif
  return shadow;
}

float pointFrameShadow() {
  float shadow = 1.0;
  #if defined(USE_SHADOWMAP) && NUM_POINT_LIGHT_SHADOWS > 0
    PointLightShadow pointLight = pointLightShadows[0];
    shadow = receiveShadow ? getPointShadow(pointShadowMap[0], pointLight.shadowMapSize,
      pointLight.shadowIntensity, pointLight.shadowBias, pointLight.shadowRadius,
      vPointShadowCoord[0], pointLight.shadowCameraNear, pointLight.shadowCameraFar) : 1.0;
  #endif
  return shadow;
}

void main() {
  if (uReady < .5) discard;
  vec4 original = optionalLayer(uBodyMap, uBodyRect, uBodyCanvasRect, vCanvasUv, vec4(0.0));
  float alpha = original.a;
  if (uHasMask > .5) alpha = outside(vCanvasUv, uMaskCanvasRect) ? 0.0
    : selectedChannel(sampleLayer(uMaskMap, uMaskRect, uMaskCanvasRect, vCanvasUv), uMaskChannel);
  bool alphaDebug = uDebugView > 7.5;
  float splitBlend = step(uSplitPosition, gl_FragCoord.x / max(uViewport.x, 1.0));
  bool opaqueAlphaDebug = alphaDebug && (uSplitView < .5 || splitBlend > 0.0);
  if (!opaqueAlphaDebug && (alpha <= 0.0 || alpha < uAlphaTest)) discard;

  vec3 originalColor = dewhite(clamp(original.rgb * uAppearanceSlope + uAppearanceBias, 0.0, 1.0), alpha);
  vec4 surface = optionalLayer(uSurfaceMap, uSurfaceRect, uSurfaceCanvasRect, vCanvasUv,
    vec4(.5, .5, 1.0, .5));
  vec4 packed = optionalLayer(uMaterialMap, uMaterialRect, uMaterialCanvasRect, vCanvasUv,
    vec4(.5, .7, 0.0, 1.0));
  vec3 inverseColor = originalColor;
  float baseColorAvailable = uHasBaseColor * (outside(vCanvasUv, uBaseColorCanvasRect) ? 0.0 : 1.0);
  if (baseColorAvailable > .5) {
    inverseColor = sampleLayer(uBaseColorMap, uBaseColorRect, uBaseColorCanvasRect, vCanvasUv).rgb;
  }
  vec4 detailSample = original;
  float detailAvailable = uHasOriginalBlur * (outside(vCanvasUv, uOriginalBlurCanvasRect) ? 0.0 : 1.0);
  if (detailAvailable > .5) {
    detailSample = sampleLayer(uOriginalBlurMap, uOriginalBlurRect, uOriginalBlurCanvasRect, vCanvasUv);
  }
  vec3 hybridColor = originalColor;
  if (baseColorAvailable > .5 && detailAvailable > .5) {
    vec3 detail = clamp(originalColor / max(detailSample.rgb, vec3(.04)), vec3(uDetailMin), vec3(uDetailMax));
    hybridColor = inverseColor * mix(vec3(1.0), detail, uDetailStrength);
  }
  float logShading = mix(uDeLitRange.x, uDeLitRange.y,
    mix(surface.a, detailSample.a, detailAvailable));
  vec3 deLitColor = originalColor * exp(-uDeLightStrength * logShading);
  vec3 baseColor = originalColor;
  if (uBaseColorMode > .5) baseColor = inverseColor;
  if (uBaseColorMode > 1.5) baseColor = hybridColor;
  if (uBaseColorMode > 2.5) baseColor = deLitColor;
  baseColor *= uAlbedoTint * uAlbedoGain * exp2(uExposureCompensation);

  vec3 normal = decodeNormal(surface.rgb);
  float roughnessSample = mix(uRoughnessFallback, packed.g, uUseRoughnessMap * uHasMaterial);
  float roughness = clamp(roughnessSample * uRoughnessScale + uRoughnessBias,
    max(min(uRoughnessMin, uRoughnessMax), .08), max(max(uRoughnessMin, uRoughnessMax), .08));
  float metallicSample = mix(uMetallicFallback, packed.b, uUseMetallicMap * uHasMaterial);
  metallicSample = metallicSample < uMetallicThreshold ? 0.0 : metallicSample;
  float metallic = clamp(metallicSample * uMetallicScale + uMetallicBias, 0.0, 1.0) * (1.0 - uForceNonMetal);
  float depth01 = normalizedDepth(packed.r);
  float depthOffset = (depth01 - .5) * uCharacterThickness * uDepthPositionEnabled;
  vec3 pixelPositionView = vPlanePositionView + vec3(0.0, 0.0, depthOffset);

  vec3 directional = safeNormalize(uDirectionalDirection, vec3(0.0, 0.0, 1.0));
  vec3 directionalSpecular;
  vec3 direct = evaluateLight(baseColor, normal, directional, uDirectionalColor * uDirectionalIntensity,
    roughness, metallic, directionalSpecular);
  float directionVisibility = traceSelfShadow(vCanvasUv, depth01, directional);
  directionVisibility *= mix(1.0, directionalFrameShadow(), uFrameShadowEnabled * uFrameShadowStrength);
  direct *= directionVisibility;
  directionalSpecular *= directionVisibility;

  vec3 pointSpecular = vec3(0.0);
  if (uPointEnabled > .5 && uPointIntensity > 0.0) {
    vec3 delta = uPointPosition - pixelPositionView;
    float distance = length(delta);
    vec3 pointDirection = safeNormalize(delta, vec3(0.0, 0.0, 1.0));
    vec3 pointDirect = evaluateLight(baseColor, normal, pointDirection,
      uPointColor * uPointIntensity * pointAttenuation(distance), roughness, metallic, pointSpecular);
    float pointVisibility = traceSelfShadow(vCanvasUv, depth01, pointDirection);
    pointVisibility *= mix(1.0, pointFrameShadow(), uFrameShadowEnabled * uFrameShadowStrength);
    direct += pointDirect * pointVisibility;
    pointSpecular *= pointVisibility;
  }

  vec3 hemiDirection = safeNormalize(uHemisphereDirection, vec3(0.0, 1.0, 0.0));
  float hemiMix = dot(normal, hemiDirection) * .5 + .5;
  vec3 hemisphere = mix(uHemisphereGround, uHemisphereSky, hemiMix) * uHemisphereIntensity;
  vec3 ambient = baseColor * (1.0 - metallic) * hemisphere / PI;
  float rim = pow(1.0 - clamp(normal.z, 0.0, 1.0), max(uRimPower, .01));
  rim *= 1.0 - max(dot(normal, directional), 0.0);
  vec3 litResult = ambient + direct + uDirectionalColor * uDirectionalIntensity * rim * uRimEnabled * uRimIntensity;

  #ifdef SPRITE_FIT_OUTPUT
    #if SPRITE_FIT_OUTPUT == 1
      gl_FragColor = vec4(baseColor, alpha);
    #elif SPRITE_FIT_OUTPUT == 2
      gl_FragColor = vec4(normal, alpha);
    #elif SPRITE_FIT_OUTPUT == 3
      gl_FragColor = vec4(roughness, metallic, 0.0, alpha);
    #elif SPRITE_FIT_OUTPUT == 4
      gl_FragColor = vec4(originalColor, alpha);
    #else
      gl_FragColor = vec4(litResult, alpha);
    #endif
    return;
  #endif

  vec3 result = mix(litResult, originalColor, uUnlit);

  if (uGbufferEnabled < .5 || uLightingEnabled < .5) result = originalColor;
  if (uDebugView > .5 && uDebugView < 1.5) result = normal * .5 + .5;
  else if (uDebugView > 1.5 && uDebugView < 2.5) result = vec3(max(dot(normal, directional), 0.0));
  else if (uDebugView > 2.5 && uDebugView < 3.5) result = vec3(depth01);
  else if (uDebugView > 3.5 && uDebugView < 4.5) result = vec3(roughness);
  else if (uDebugView > 4.5 && uDebugView < 5.5) result = vec3(metallic);
  else if (uDebugView > 5.5 && uDebugView < 6.5) result = directionalSpecular + pointSpecular;
  else if (uDebugView > 6.5 && uDebugView < 7.5) result = originalColor / max(inverseColor, vec3(.04));
  else if (uDebugView > 7.5) result = vec3(alpha);

  bool dataDebug = (uDebugView > .5 && uDebugView < 5.5) || alphaDebug;
  if (uSplitView > .5) {
    vec3 splitOriginal = originalColor;
    #if defined(TONE_MAPPING)
      if (dataDebug) splitOriginal = toneMapping(splitOriginal);
    #endif
    result = mix(splitOriginal, result, splitBlend);
  }
  float outputAlpha = alphaDebug ? mix(alpha, 1.0, mix(1.0, splitBlend, uSplitView)) : alpha;
  gl_FragColor = vec4(max(result, vec3(0.0)), outputAlpha);
  if (!dataDebug) {
    #include <tonemapping_fragment>
  }
  #include <colorspace_fragment>
}
`;
