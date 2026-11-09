import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig } from "wxt";
import { source } from "../../vite.source.ts";

// The end-to-end tests (e2e/) build a variant with WEFT_E2E=1: it may reach
// localhost from install, so enrolling there doesn't stop at the browser's
// permission prompt, which automated browsers can't click. It goes to its own
// folder so it's never mistaken for a release build.
const e2e = process.env.WEFT_E2E === "1";

// WEFT_EXPERIMENTAL=1 builds Weft Experimental (docs/adr/0009), a separate
// extension: its own name, its own folder (so Chrome gives the unpacked
// extension its own ID), its own Firefox add-on ID, and therefore its own
// storage. lib/experimental.ts reads the constant defined below, and the
// normal build leaves out every branch that tests it.
const experimental = process.env.WEFT_EXPERIMENTAL === "1";
const productName = experimental ? "Weft Experimental" : "Weft";
/** .output, .output-e2e, .output-experimental or .output-e2e-experimental. */
const outDir = [".output", e2e && "e2e", experimental && "experimental"].filter(Boolean).join("-");
/** The dev browsers' profiles, kept apart so the two wallets never share one. */
/** Weft Experimental has its own icon, the main mark with a pinked edge. */
const iconDir = experimental ? "icon-experimental" : "icon";
const profileSuffix = experimental ? "-experimental" : "";

// Weft Experimental's voter credentials (docs/adr/0008) run IBM's idemix
// library as WebAssembly, built from Go source in packages/idemix and pinned
// by hash there. Only Weft Experimental carries the module and its loader,
// at /idemix/, and only its extension pages may compile WebAssembly, which
// Manifest V3's default policy forbids.
const idemixDist = resolve(import.meta.dirname, "../../packages/idemix/dist/wasm");
const IDEMIX_FILES = ["weft-idemix.wasm", "wasm_exec.js"];
function idemixModule(): string {
  if (!IDEMIX_FILES.every((f) => existsSync(join(idemixDist, f)))) {
    // Builds it from source when dist has none with the pinned hash (D1 of step 5). Needs Go.
    const built = spawnSync(process.execPath, [resolve(idemixDist, "../../scripts/build.mjs"), "--if-missing"], { stdio: "inherit" });
    if (built.status !== 0) throw new Error("Weft Experimental needs the idemix module, and packages/idemix/scripts/build.mjs couldn't build it. See packages/idemix/README.md.");
  }
  return idemixDist;
}
const EXPERIMENTAL_CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';";

// Each build carries the time it was made, import.meta.env.WEFT_BUILT_AT (an
// ISO string), so the popup can tell when the background runs other code
// than its own window (lib/build-stamp.ts). A release build has one stamp,
// taken as it starts. In dev, the background is built to disk and rebuilt on
// each change, while pages load from the Vite dev server: the stamp is then
// the time of the background's latest build, and the dev server gives each
// page the stamp current when the page loads. The two match unless the
// browser kept running an older background. Kept on globalThis because WXT
// loads this file again on every change in dev.
interface BuildStamp {
  at: string;
  /** True under `wxt` (dev), false under `wxt build`. */
  serve: boolean;
  /** Dev servers, and the modules each has transformed that read the stamp. */
  pages: Map<DevServer, Set<string>>;
}
interface DevServer {
  moduleGraph: { getModuleById(id: string): unknown; invalidateModule(module: never): void };
}
const stamp: BuildStamp = ((globalThis as { weftBuildStamp?: BuildStamp }).weftBuildStamp ??= { at: new Date().toISOString(), serve: false, pages: new Map() });
const STAMP_KEY = "import.meta.env.WEFT_BUILT_AT";

/** A new stamp, and every page module the dev servers hold marked for transforming again, so a page that loads next reads it. */
function restamp(): void {
  stamp.at = new Date().toISOString();
  for (const [server, ids] of stamp.pages) {
    for (const id of ids) {
      const module = server.moduleGraph.getModuleById(id);
      if (module) server.moduleGraph.invalidateModule(module as never);
    }
  }
}

// Before reusing a Firefox profile, web-ext reads Firefox's own profiles.ini
// to make sure it isn't your everyday profile. macOS can refuse a terminal
// that read, and web-ext then stops. Where it can't be read, the dev Firefox
// starts with a new profile each time instead, as it used to.
function firefoxProfileCheckable(): boolean {
  const home = homedir();
  const ini =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support", "Firefox", "profiles.ini")
      : process.platform === "win32"
        ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Mozilla", "Firefox", "profiles.ini")
        : join(home, ".mozilla", "firefox", "profiles.ini");
  try {
    accessSync(ini, constants.R_OK);
    return true;
  } catch (error) {
    // No Firefox profiles yet is fine: web-ext has nothing to check.
    return (error as { code?: string }).code === "ENOENT";
  }
}
const keepFirefoxProfile = firefoxProfileCheckable();

// https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // Reads the workspace packages from their source, so a stale build is never used.
  vite: () => ({
    ...source,
    define: { "import.meta.env.WEFT_EXPERIMENTAL": JSON.stringify(experimental), [STAMP_KEY]: JSON.stringify(stamp.at) },
    plugins: [
      {
        // The dev server's pages read the stamp as each module is
        // transformed, not when the server started (above).
        name: "weft-build-stamp",
        apply: "serve" as const,
        enforce: "pre" as const,
        configureServer(server: DevServer) {
          stamp.pages.set(server, new Set());
        },
        transform(code: string, id: string) {
          if (!code.includes(STAMP_KEY)) return null;
          for (const ids of stamp.pages.values()) ids.add(id);
          return { code: code.replaceAll(STAMP_KEY, JSON.stringify(stamp.at)), map: null };
        },
      },
      {
        // The windows' titles ("Weft · Approve request") name the product.
        name: "weft-product-name",
        transformIndexHtml: (html: string) => html.replace(/<title>Weft\b/, `<title>${productName}`),
      },
    ],
  }),
  outDir,
  // pnpm dev:extension opens its own Chrome with Weft loaded, and dev:firefox
  // its own Firefox. Each keeps its profile in .wxt (chrome-data and
  // firefox-data), so the wallet you set up there is still there the next
  // time. Delete the folder to start from a new wallet. Your own settings
  // for them go in web-ext.config.ts next to this file, which git ignores.
  webExt: {
    chromiumArgs: [`--user-data-dir=./.wxt/chrome-data${profileSuffix}`],
    ...(keepFirefoxProfile ? { firefoxProfile: `./.wxt/firefox-data${profileSuffix}`, keepProfileChanges: true } : {}),
  },
  hooks: {
    "config:resolved": (wxt) => {
      stamp.serve = wxt.config.command === "serve";
    },
    "build:before": () => {
      stamp.at = new Date().toISOString();
    },
    // In dev, each build of the background takes a new stamp (above).
    "vite:build:extendConfig": (entrypoints, config) => {
      if (!stamp.serve) return;
      if (entrypoints.some((e) => e.type === "background")) restamp();
      config.define = { ...config.define, [STAMP_KEY]: JSON.stringify(stamp.at) };
    },
    // The idemix module's worker (entrypoints/idemix-worker.ts) is Weft
    // Experimental's alone, so the normal build leaves the entrypoint out.
    "entrypoints:found": (_wxt, infos) => {
      if (experimental) return;
      const keep = infos.filter((info) => info.name !== "idemix-worker");
      infos.splice(0, infos.length, ...keep);
    },
    // Each build ships only its own icons: public/icon for Weft,
    // public/icon-experimental for Weft Experimental.
    "build:publicAssets": (_wxt, files) => {
      const other = experimental ? "icon/" : "icon-experimental/";
      const keep = files.filter((file) => !file.relativeDest.startsWith(other));
      files.splice(0, files.length, ...keep);
      if (experimental) {
        const dir = idemixModule();
        for (const name of IDEMIX_FILES) files.push({ absoluteSrc: join(dir, name), relativeDest: `idemix/${name}` });
      }
    },
    ready: (wxt) => {
      if (wxt.config.command !== "serve" || wxt.config.browser !== "firefox") return;
      // web-ext only reuses a Firefox profile folder that exists.
      if (keepFirefoxProfile) mkdirSync(`.wxt/firefox-data${profileSuffix}`, { recursive: true });
      else wxt.logger.warn("This Firefox starts with a new profile, because the terminal can't read Firefox's profiles.ini, which web-ext checks before reusing one. See the extension README.");
    },
  },
  // Manifest V3 for Firefox too. WXT builds Firefox as V2 by default, and V2
  // has no optional_host_permissions, so Weft could never ask for a network's
  // hosts there.
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: experimental ? "Weft Experimental" : "Weft Wallet",
    description: experimental
      ? "Weft built with experimental features that no one outside the project has reviewed. For testing only."
      : "An identity wallet for Hyperledger Fabric. It holds the certificate your organisation's CA issued you and signs only the transactions you approve.",
    // alarms: an hourly check for expiring certificates (lib/certificate-watch.ts).
    permissions: ["storage", "unlimitedStorage", "activeTab", "alarms"],
    // CA and relay hosts differ per organisation, so access is requested at
    // runtime, per host, when the user adds a network.
    optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
    ...(e2e ? { host_permissions: ["http://localhost/*", "http://127.0.0.1/*"] } : {}),
    action: { default_title: experimental ? "Weft Experimental" : "Weft Wallet" },
    ...(experimental ? { content_security_policy: { extension_pages: EXPERIMENTAL_CSP } } : {}),
    icons: Object.fromEntries([16, 32, 48, 128].map((size) => [size, `${iconDir}/${size}.png`])),
    // Firefox wants an add-on ID, and new add-ons must say what data they
    // collect: none, which needs Firefox 140. Weft Experimental has an ID of
    // its own, so Firefox installs it alongside Weft with separate storage.
    ...(browser === "firefox"
      ? { browser_specific_settings: { gecko: { id: experimental ? "experimental@weft.ifeanyiugwu.dev" : "wallet@weft.ifeanyiugwu.dev", strict_min_version: "140.0", data_collection_permissions: { required: ["none"] } }, gecko_android: { strict_min_version: "142.0" } } }
      : {}),
  }),
});
