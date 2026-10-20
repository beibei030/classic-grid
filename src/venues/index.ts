import type { VenueId } from "../types.js";
import { DecibelExecutor } from "./decibel.js";
import { N1Executor } from "./n1.js";
import { PopdexExecutor } from "./popdex.js";
import { RisexExecutor } from "./risex.js";
import type { VenueExecutor } from "./types.js";

export function createExecutor(venue: VenueId, dryRun: boolean): VenueExecutor {
  switch (venue) {
    case "risex":
      return new RisexExecutor(dryRun);
    case "decibel":
      return new DecibelExecutor(dryRun);
    case "n1":
      return new N1Executor(dryRun);
    case "popdex":
      return new PopdexExecutor(dryRun);
  }
}

export type { VenueExecutor } from "./types.js";
