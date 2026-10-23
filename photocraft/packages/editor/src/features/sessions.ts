import { createSession as files } from "./files/workspace.js";
import { createSession as io } from "./io/workspace.js";
import { createSession as vectors } from "./vectors/workspace.js";
import { createSession as selections } from "./selections/workspace.js";
import { createSession as channels } from "./channels/workspace.js";
import { createSession as painting } from "./painting/workspace.js";
import { createSession as retouch } from "./retouch/workspace.js";
import { createSession as adjustments } from "./adjustments/workspace.js";
import { createSession as modes } from "./modes/workspace.js";
import { createSession as filters } from "./filters/workspace.js";
import { createSession as composition } from "./composition/workspace.js";
import { createSession as layers } from "./layers/workspace.js";
import { createSession as smart } from "./smart/workspace.js";
import { createSession as type } from "./type/workspace.js";
import { createSession as views } from "./views/workspace.js";
import { createSession as customization } from "./customization/workspace.js";
import { createSession as history } from "./history/workspace.js";
import { createSession as animation } from "./animation/workspace.js";
import type { WorkspaceFeatureContext } from "./workspace-context.js";
export function createFeatureSessions(context: () => WorkspaceFeatureContext) {
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
