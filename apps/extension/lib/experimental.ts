/**
 * Weft Experimental (docs/adr/0009): the same extension built with
 * WEFT_EXPERIMENTAL=1, as a separate product with its own name, extension ID
 * and storage.
 *
 * EXPERIMENTAL is the one constant that gates experimental code. wxt.config.ts
 * replaces import.meta.env.WEFT_EXPERIMENTAL with true or false at build time,
 * so in the normal build every `if (EXPERIMENTAL)` branch is dead code and the
 * bundler drops it. Experimental code is only ever reached through it. The
 * e2e tests check that the normal build contains none of it.
 *
 * A branch that imports a whole experimental module (the ballot handler with
 * @weftwallet/tally, the ballot window) tests import.meta.env.WEFT_EXPERIMENTAL
 * itself, in the importing file. The bundler folds a constant from another
 * module only after it has chosen the modules, so with EXPERIMENTAL there it
 * would drop the branch but keep the module's top-level code.
 */

import { PROVIDER_FEATURES, type ExperimentalFeature, type WeftFeature } from "@weftwallet/protocol";

declare global {
  interface ImportMetaEnv {
    /** Set by wxt.config.ts. Undefined in unit tests, which test the normal build. */
    readonly WEFT_EXPERIMENTAL?: boolean;
  }
}

/** True only in Weft Experimental. */
export const EXPERIMENTAL: boolean = import.meta.env.WEFT_EXPERIMENTAL === true;

/** The product's name, as the popup and the windows show it. */
export const PRODUCT_NAME: string = EXPERIMENTAL ? "Weft Experimental" : "Weft";

/**
 * The experimental features this build offers. Each feature adds its name
 * here when its code lands: "castBallot" (ADR 0007), then
 * "voterCredentials" (ADR 0008). Nothing else lists them.
 */
const EXPERIMENTAL_FEATURES: readonly ExperimentalFeature[] = ["castBallot", "voterCredentials"];

/** `window.weft.features`: ["receipts"] in Weft, plus EXPERIMENTAL_FEATURES in Weft Experimental. */
export const FEATURES: readonly (WeftFeature | ExperimentalFeature)[] = EXPERIMENTAL
  ? [...PROVIDER_FEATURES, ...EXPERIMENTAL_FEATURES]
  : PROVIDER_FEATURES;
