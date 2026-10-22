import { canonicalFilmSetFields, createFilmSetSnapshot } from "@woohaa3/contracts";
import { FILM_SET_LABEL } from "./identity.js";

export function createFilmSetNodeData() {
  return canonicalFilmSetFields(createFilmSetSnapshot({ title: FILM_SET_LABEL, timeline: { duration: 0, loop: false } }));
}
