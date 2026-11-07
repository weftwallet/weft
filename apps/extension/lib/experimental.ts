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
const EXPERIMENTAL_FEATURES: readonly ExperimentalFeature[] = [];

/** `window.weft.features`: ["receipts"] in Weft, plus EXPERIMENTAL_FEATURES in Weft Experimental. */
export const FEATURES: readonly (WeftFeature | ExperimentalFeature)[] = EXPERIMENTAL
  ? [...PROVIDER_FEATURES, ...EXPERIMENTAL_FEATURES]
  : PROVIDER_FEATURES;
