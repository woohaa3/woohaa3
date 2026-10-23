import { feature as files } from "./files/index.js";
import { feature as io } from "./io/index.js";
import { feature as vectors } from "./vectors/index.js";
import { feature as selections } from "./selections/index.js";
import { feature as channels } from "./channels/index.js";
import { feature as painting } from "./painting/index.js";
import { feature as retouch } from "./retouch/index.js";
import { feature as adjustments } from "./adjustments/index.js";
import { feature as modes } from "./modes/index.js";
import { feature as filters } from "./filters/index.js";
import { feature as composition } from "./composition/index.js";
import { feature as layers } from "./layers/index.js";
import { feature as smart } from "./smart/index.js";
import { feature as type } from "./type/index.js";
import { feature as views } from "./views/index.js";
import { feature as customization } from "./customization/index.js";
import { feature as history } from "./history/index.js";
import { feature as animation } from "./animation/index.js";

export const PROTOCOL_FEATURES = [files, io, vectors, selections, channels, painting, retouch, adjustments, modes, filters, composition, layers, smart, type, views, customization, history, animation] as const;
export function featureCapabilitiesForStage(stage: string): string[] {
  return PROTOCOL_FEATURES.flatMap(feature => [...feature.capabilities])
    .filter(entry => entry.stage === stage).sort((a, b) => a.order - b.order).map(entry => entry.id);
}
