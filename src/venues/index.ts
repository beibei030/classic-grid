import type { VenueId } from "../types.js";
import { DecibelExecutor } from "./decibel.js";
import { EntropyExecutor } from "./entropy.js";
import { ExtendedExecutor } from "./extended.js";
import { N1Executor } from "./n1.js";
import { NadoExecutor } from "./nado.js";
import { PhoenixExecutor } from "./phoenix.js";
import { LighterExecutor } from "./lighter.js";
import { PacificaExecutor } from "./pacifica.js";
import { PopdexExecutor } from "./popdex.js";
import { RisexExecutor } from "./risex.js";
import type { VenueExecutor } from "./types.js";

export function createExecutor(venue: VenueId, dryRun: boolean): VenueExecutor {
  switch (venue) {
    case "extended":
      return new ExtendedExecutor(dryRun);
    case "risex":
      return new RisexExecutor(dryRun);
    case "decibel":
      return new DecibelExecutor(dryRun);
    case "n1":
      return new N1Executor(dryRun);
    case "phoenix":
      return new PhoenixExecutor(dryRun, "phoenix");
    case "phoenix2":
      return new PhoenixExecutor(dryRun, "phoenix2");
    case "nado":
      return new NadoExecutor(dryRun);
    case "popdex":
      return new PopdexExecutor(dryRun);
    case "entropy":
      return new EntropyExecutor(dryRun);
    case "pacifica":
      return new PacificaExecutor(dryRun);
    case "lighter":
      return new LighterExecutor(dryRun);
  }
}

export type { VenueExecutor } from "./types.js";
