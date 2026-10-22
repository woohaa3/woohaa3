/**
 * 查看页确定性 catalog fixtures
 * （change: expand-showcase-execution-ux，任务 3.2）。
 *
 * 覆盖 loading / error（可重试）/ 空 catalog / 目录不可用 / 没有该类型模型五种状态，
 * 彼此可区分；模型与参数形状与 `/api/pptask/catalog` 的投影输入一致（bindings + inputSchema）。
 */
import type {
  CanvasReferenceMediaKind,
  CanvasTaskCatalog,
  CanvasTaskCatalogModel,
  CanvasTaskInputBinding,
  CanvasTaskModelType
} from "@woohaa3/contracts";
import type { CatalogState, TaskCatalogService } from "../../../frontend/src/cordis/contracts.js";

export type CatalogFixtureId =
  | "ready"
  | "loading"
  | "error"
  | "empty"
  | "unavailable"
  | "languageOnly"
  | "seedance"
  | "missingPlugin"
  | "versionMismatch"
  | "providerAlias";

export const DEFAULT_CATALOG_ID: CatalogFixtureId = "ready";

function binding(input: {
  semantic: "reference-image" | "reference-video" | "reference-audio";
  roles: string[];
  mediaKinds: CanvasReferenceMediaKind[];
  mediaTypes: string[];
  maxItems: number;
  field?: string;
}): CanvasTaskInputBinding {
  return {
    field: input.field ?? input.semantic,
    semantic: input.semantic,
    roles: input.roles,
    mediaKinds: input.mediaKinds,
    mediaTypes: input.mediaTypes,
    maxItems: input.maxItems,
    valueFormat: "url"
  };
}

function model(input: {
  modelKey: string;
  modelType: CanvasTaskModelType;
  title: string;
  providerId?: string;
  providerModelId?: string;
  interaction?: { id: string; version: number };
  bindings?: CanvasTaskInputBinding[];
  defaultInput?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
}): CanvasTaskCatalogModel {
  return {
    modelKey: input.modelKey,
    providerId: input.providerId ?? "litellm",
    providerModelId: input.providerModelId ?? input.modelKey,
    modelType: input.modelType,
    title: input.title,
    interaction: input.interaction ?? { id: "generic-model", version: 1 },
    inputSchema: input.inputSchema ?? {
      type: "object",
      properties: {
        prompt: { type: "string", title: "提示词" },
        urls: { type: "array", maxItems: 16 }
      }
    },
    defaultInput: input.defaultInput ?? { prompt: "", urls: [] },
    bindings: input.bindings ?? [],
    taskTimeoutMs: 8 * 60_000
  };
}

const IMAGE_BINDING = binding({
  semantic: "reference-image",
  roles: ["reference_image"],
  mediaKinds: ["image"],
  mediaTypes: ["image/png", "image/jpeg", "image/webp"],
  maxItems: 16
});

const VIDEO_BINDING = binding({
  semantic: "reference-video",
  roles: ["edit_video", "reference_video"],
  mediaKinds: ["video"],
  mediaTypes: ["video/mp4", "video/webm"],
  maxItems: 4
});

const VIDEO_IMAGE_BINDING = binding({
  semantic: "reference-image",
  roles: ["first_frame", "last_frame", "reference_image"],
  mediaKinds: ["image"],
  mediaTypes: ["image/png", "image/jpeg", "image/webp"],
  maxItems: 2
});

const AUDIO_BINDING = binding({
  semantic: "reference-audio",
  roles: ["voice_sample", "reference_audio"],
  mediaKinds: ["audio"],
  mediaTypes: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4"],
  maxItems: 2
});

/** ready catalog：图片 / 视频 / 音频 / 文本四种模型都可用。 */
export function readyCatalog(): CanvasTaskCatalog {
  return {
    available: true,
    defaultModels: {
      image: "showcase-image",
      video: "showcase-video",
      audio: "showcase-audio-tts",
      language: "showcase-text"
    },
    models: [
      model({
        modelKey: "showcase-image",
        modelType: "image",
        title: "展示图片模型",
        bindings: [IMAGE_BINDING],
        defaultInput: { prompt: "", urls: [], ratio: "1:1", resolution: "1K" },
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", title: "提示词" },
            urls: { type: "array" },
            ratio: {
              type: "string",
              title: "画幅比例",
              enum: ["1:1", "9:16", "16:9"],
              default: "1:1"
            },
            resolution: { type: "string", title: "分辨率", enum: ["1K", "2K"], default: "1K" }
          }
        }
      }),
      model({
        modelKey: "showcase-image-alt",
        modelType: "image",
        title: "展示图片模型 · 备用",
        bindings: [IMAGE_BINDING],
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            ratio: { type: "string", title: "画幅比例", enum: ["1:1", "16:9"], default: "1:1" }
          }
        }
      }),
      model({
        modelKey: "showcase-video",
        modelType: "video",
        title: "展示视频模型",
        bindings: [VIDEO_BINDING, VIDEO_IMAGE_BINDING],
        defaultInput: { prompt: "", urls: [], durationSeconds: 5, generateAudio: true },
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            urls: { type: "array" },
            durationSeconds: {
              type: "number",
              title: "时长",
              minimum: 2,
              maximum: 12,
              step: 1,
              default: 5
            },
            generateAudio: { type: "boolean", title: "生成音频", default: true }
          }
        }
      }),
      model({
        modelKey: "showcase-audio-tts",
        modelType: "audio",
        title: "展示音频模型 · 语音",
        bindings: [AUDIO_BINDING],
        defaultInput: { prompt: "", urls: [], voice: "female-warm" },
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            urls: { type: "array" },
            voice: {
              type: "string",
              title: "音色",
              enum: [
                { value: "female-warm", label: "温暖女声" },
                { value: "male-deep", label: "沉稳男声" }
              ],
              default: "female-warm"
            }
          }
        }
      }),
      model({
        modelKey: "showcase-audio-music",
        modelType: "audio",
        title: "展示音频模型 · 音乐",
        bindings: [AUDIO_BINDING],
        defaultInput: { prompt: "", urls: [], durationSeconds: 30 },
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            urls: { type: "array" },
            durationSeconds: {
              type: "number",
              title: "时长",
              minimum: 10,
              maximum: 120,
              step: 5,
              default: 30
            }
          }
        }
      }),
      model({
        modelKey: "showcase-text",
        modelType: "language",
        title: "展示文本模型",
        defaultInput: { prompt: "" },
        inputSchema: { type: "object", properties: { prompt: { type: "string" } } }
      })
    ]
  };
}

/** Seedance 专用交互 catalog：video 模型声明 `seedance-video` interaction。 */
export function seedanceCatalog(): CanvasTaskCatalog {
  return {
    available: true,
    defaultModels: { video: "ark:seedance2_5" },
    models: [
      model({
        modelKey: "ark:seedance2_5",
        providerId: "ark",
        providerModelId: "seedance2_5",
        modelType: "video",
        title: "Seedance 2.5",
        interaction: { id: "seedance-video", version: 1 },
        bindings: [VIDEO_BINDING, VIDEO_IMAGE_BINDING],
        defaultInput: { prompt: "", urls: [], durationSeconds: 5, generationMode: "edit_video" },
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", title: "提示词" },
            urls: { type: "array" },
            generationMode: {
              type: "string",
              title: "生成模式",
              enum: ["omni_reference", "first_last_frame", "edit_video"],
              default: "edit_video"
            }
          }
        }
      }),
      // 另一个 Provider 的同名 providerModelId：验证 modelKey 隔离与交互复用。
      model({
        modelKey: "litellm:seedance2_5",
        providerId: "litellm",
        providerModelId: "seedance2_5",
        modelType: "video",
        title: "Seedance 2.5（LiteLLM）",
        interaction: { id: "seedance-video", version: 1 },
        bindings: [VIDEO_BINDING, VIDEO_IMAGE_BINDING],
        defaultInput: { prompt: "", urls: [], durationSeconds: 5 }
      })
    ]
  };
}

function readonlyService(state: CatalogState): TaskCatalogService {
  let current = state;
  const listeners = new Set<() => void>();
  return {
    // 固定 fixture 无远端缓存；失效后仍使用同一份目录。
    invalidate: () => {},
    getState: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load: async () => {
      current = state;
    }
  };
}

export type CatalogFixture = {
  id: CatalogFixtureId;
  label: string;
  /** 造一个状态 fixture 用的目录服务。 */
  service: () => TaskCatalogService;
};

export const CATALOG_FIXTURES: Record<CatalogFixtureId, CatalogFixture> = {
  ready: {
    id: "ready",
    label: "目录就绪",
    service: () => readonlyService({ status: "ready", catalog: readyCatalog() })
  },
  loading: {
    id: "loading",
    label: "目录加载中",
    service: () => readonlyService({ status: "loading" })
  },
  error: {
    id: "error",
    label: "目录加载失败（可重试）",
    service: () => {
      // 第一次 load 失败，重试（force）后成功：retry 动作可被真实断言。
      let attempt = 0;
      let current: CatalogState = { status: "loading" };
      const listeners = new Set<() => void>();
      const emit = () => {
        for (const listener of listeners) listener();
      };
      return {
        invalidate: () => { current = { status: "loading" }; emit(); },
        getState: () => current,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        load: async () => {
          attempt += 1;
          current =
            attempt === 1
              ? { status: "error", error: "展示用目录请求失败" }
              : { status: "ready", catalog: readyCatalog() };
          emit();
        }
      };
    }
  },
  empty: {
    id: "empty",
    label: "空 catalog（available，无模型）",
    service: () =>
      readonlyService({ status: "ready", catalog: { available: true, models: [], defaultModels: {} } })
  },
  unavailable: {
    id: "unavailable",
    label: "目录不可用（available=false）",
    service: () =>
      readonlyService({
        status: "ready",
        catalog: { available: false, reason: "展示用：LiteLLM 未配置", models: [], defaultModels: {} }
      })
  },
  languageOnly: {
    id: "languageOnly",
    label: "没有该类型可用模型",
    service: () => {
      const catalog = readyCatalog();
      return readonlyService({
        status: "ready",
        catalog: { ...catalog, models: catalog.models.filter((entry) => entry.modelType === "language") }
      });
    }
  },
  seedance: {
    id: "seedance",
    label: "Seedance 专用交互（含 Provider 同名模型）",
    service: () => readonlyService({ status: "ready", catalog: seedanceCatalog() })
  },
  missingPlugin: {
    id: "missingPlugin",
    label: "缺 Plugin（交互未注册）",
    service: () =>
      readonlyService({
        status: "ready",
        catalog: {
          available: true,
          defaultModels: { image: "showcase-image" },
          models: readyCatalog().models.map((entry) =>
            entry.modelType === "image"
              ? { ...entry, interaction: { id: "unknown-image-interaction", version: 1 } }
              : entry
          )
        }
      })
  },
  versionMismatch: {
    id: "versionMismatch",
    label: "Version mismatch（id 匹配、version 不匹配）",
    service: () =>
      readonlyService({
        status: "ready",
        catalog: {
          available: true,
          defaultModels: { image: "showcase-image" },
          models: readyCatalog().models.map((entry) =>
            entry.modelType === "image"
              ? { ...entry, interaction: { id: "generic-model", version: 99 } }
              : entry
          )
        }
      })
  },
  providerAlias: {
    id: "providerAlias",
    label: "两个 Provider 的同名 providerModelId",
    service: () =>
      readonlyService({
        status: "ready",
        catalog: {
          available: true,
          defaultModels: { image: "litellm:gpt-image-2" },
          models: [
            model({
              modelKey: "litellm:gpt-image-2",
              providerId: "litellm",
              providerModelId: "gpt-image-2",
              modelType: "image",
              title: "Image 2（LiteLLM）",
              bindings: [IMAGE_BINDING],
              defaultInput: { prompt: "", urls: [], ratio: "1:1" },
              inputSchema: {
                type: "object",
                properties: {
                  prompt: { type: "string", title: "提示词" },
                  urls: { type: "array" },
                  ratio: { type: "string", title: "画幅比例", enum: ["1:1", "16:9"], default: "1:1" }
                }
              }
            }),
            model({
              modelKey: "vertex:gpt-image-2",
              providerId: "vertex",
              providerModelId: "gpt-image-2",
              modelType: "image",
              title: "Image 2（Vertex）",
              bindings: [IMAGE_BINDING],
              defaultInput: { prompt: "", urls: [], resolution: "1K" },
              inputSchema: {
                type: "object",
                properties: {
                  prompt: { type: "string", title: "提示词" },
                  urls: { type: "array" },
                  resolution: { type: "string", title: "分辨率", enum: ["1K", "2K"], default: "1K" }
                }
              }
            })
          ]
        }
      })
  }
};
