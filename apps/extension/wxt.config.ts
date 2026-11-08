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
    define: { "import.meta.env.WEFT_EXPERIMENTAL": JSON.stringify(experimental) },
    // The idemix module's worker (lib/voter/idemix.worker.ts) is a module worker: it imports wasm_exec.js at run time.
    worker: { format: "es" as const },
    plugins: [
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
