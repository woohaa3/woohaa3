import type { ApplicationExtensionArchiveDefinition } from "@woohaa3/contracts";
import { collectGameFurnaceMediaKeys } from "../../state/shared/archive.js";

/** Neutral contribution available while the extension is disabled. */
export const gameFurnaceArchiveDefinition: ApplicationExtensionArchiveDefinition = {
  extensionId: "game-furnace",
  collectMediaKeys: collectGameFurnaceMediaKeys
};
