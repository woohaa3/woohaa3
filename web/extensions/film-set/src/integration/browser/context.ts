import type { FilmSetHostContext } from "../../state/browser/host-ports.js";
import type { FilmSetPlaybackService } from "../../preview/browser/playback-service.js";

export type FilmSetContext = FilmSetHostContext & { filmSetPlayback: FilmSetPlaybackService };
