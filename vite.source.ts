// Makes Vite (the docs, the extension and every package's tests) read Weft's
// workspace packages from their source, through the "weft-source" condition
// in their package.json exports, instead of from a dist/ that may be stale.
// Node runs only the built packages: production, the playground and Docker.
//
// Setting conditions replaces Vite's defaults, so they're repeated here.
export const conditions: string[] = ["weft-source", "module", "browser", "development|production"];
export const serverConditions: string[] = ["weft-source", "module", "node", "development|production"];

/** Vite config to merge into a project's own. */
export const source = {
  resolve: { conditions },
  ssr: { resolve: { conditions: serverConditions } },
};
