import { createHandle as files } from "./files/wasm-handle.js";
import { createHandle as io } from "./io/wasm-handle.js";
import { createHandle as vectors } from "./vectors/wasm-handle.js";
import { createHandle as selections } from "./selections/wasm-handle.js";
import { createHandle as channels } from "./channels/wasm-handle.js";
import { createHandle as painting } from "./painting/wasm-handle.js";
import { createHandle as retouch } from "./retouch/wasm-handle.js";
import { createHandle as adjustments } from "./adjustments/wasm-handle.js";
import { createHandle as modes } from "./modes/wasm-handle.js";
import { createHandle as filters } from "./filters/wasm-handle.js";
import { createHandle as composition } from "./composition/wasm-handle.js";
import { createHandle as layers } from "./layers/wasm-handle.js";
import { createHandle as smart } from "./smart/wasm-handle.js";
import { createHandle as type } from "./type/wasm-handle.js";
import { createHandle as views } from "./views/wasm-handle.js";
import { createHandle as customization } from "./customization/wasm-handle.js";
import { createHandle as history } from "./history/wasm-handle.js";
import { createHandle as animation } from "./animation/wasm-handle.js";
import type { FeatureHandleContext } from "./contracts.js";
export function createFeatureHandles(context: () => FeatureHandleContext) {
  return {
    files: files(context),
    io: io(context),
    vectors: vectors(context),
    selections: selections(context),
    channels: channels(context),
    painting: painting(context),
    retouch: retouch(context),
    adjustments: adjustments(context),
    modes: modes(context),
    filters: filters(context),
    composition: composition(context),
    layers: layers(context),
    smart: smart(context),
    type: type(context),
    views: views(context),
    customization: customization(context),
    history: history(context),
    animation: animation(context),
  };
}
