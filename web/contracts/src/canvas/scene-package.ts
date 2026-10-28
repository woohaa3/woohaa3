import type { ServerCanvas } from './domain/types.js';
export const SCENE_PACKAGE_LIMITS = { compressedBytes: 256 * 1024 * 1024, unpackedBytes: 512 * 1024 * 1024, decodedImageBytes: 512 * 1024 * 1024, entries: 4096, nodes: 50000, edges: 200000 } as const;
export type ScenePackageKind = 'text' | 'image' | 'model3d';
export type ScenePackageMediaEntry = {
    assetId: string;
    path: string;
    sha256: string;
    size: number;
    mimeType: string;
};
export type ScenePackageManifest = {
    format: 'woohaa-scene';
    version: 1;
    datasetId: string;
    contentHash: string;
    recipeVersion: number;
    kind: ScenePackageKind;
    title: string;
    scene: {
        sha256: string;
        size: number;
    };
    inventory: {
        nodes: number;
        edges: number;
        media: number;
    };
    compatibility: {
        minAppVersion: string;
        capabilities: string[];
    };
    views: {
        overview200: string[];
        overview300: string[];
        distant: string[];
    };
    media: ScenePackageMediaEntry[];
};
export type ScenePackageExperienceMetadata = {
    datasetId: string;
    contentHash: string;
    recipeVersion: number;
    kind: ScenePackageKind;
    views: ScenePackageManifest['views'];
};
export type ScenePackageImportReceipt = {
    canvasId: string;
    operationId: string;
    packageHash: string;
    manifest: ScenePackageManifest;
    importedAt: string;
};
export type ScenePackageJob = {
    operationId: string;
    packageHash: string;
    canvasId: string;
    phase: 'uploaded' | 'validating' | 'staging-media' | 'committing' | 'ready' | 'failed' | 'cancelled';
    completedMedia: number;
    totalMedia: number;
    error?: {
        code: string;
        message: string;
        retryable: boolean;
    };
};
export type DecodedScenePackage = {
    manifest: ScenePackageManifest;
    canvas: ServerCanvas;
    media: Map<string, Uint8Array>;
};
/** Stable logical reference, replaced with host-owned asset identity at publication. */
export function scenePackageAssetRef(assetId: string): string { return `scene-media:${assetId}`; }
/** Portable package models use the same bounded static-model validator as authoring. */
export { validateSelfContainedModel as validateScenePackageModel } from './model-validity.js';
