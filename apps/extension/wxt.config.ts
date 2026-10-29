import { accessSync, constants, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "wxt";
import { source } from "../../vite.source.ts";

// The end-to-end tests (e2e/) build a variant with WEFT_E2E=1: it may reach
// localhost from install, so enrolling there doesn't stop at the browser's
// permission prompt, which automated browsers can't click. It goes to its own
// folder so it's never mistaken for a release build.
const e2e = process.env.WEFT_E2E === "1";

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
  vite: () => source,
  outDir: e2e ? ".output-e2e" : ".output",
  // pnpm dev:extension opens its own Chrome with Weft loaded, and dev:firefox
  // its own Firefox. Each keeps its profile in .wxt (chrome-data and
  // firefox-data), so the wallet you set up there is still there the next
  // time. Delete the folder to start from a new wallet. Your own settings
  // for them go in web-ext.config.ts next to this file, which git ignores.
  webExt: {
    chromiumArgs: ["--user-data-dir=./.wxt/chrome-data"],
    ...(keepFirefoxProfile ? { firefoxProfile: "./.wxt/firefox-data", keepProfileChanges: true } : {}),
  },
  hooks: {
    ready: (wxt) => {
      if (wxt.config.command !== "serve" || wxt.config.browser !== "firefox") return;
      // web-ext only reuses a Firefox profile folder that exists.
      if (keepFirefoxProfile) mkdirSync(".wxt/firefox-data", { recursive: true });
      else wxt.logger.warn("This Firefox starts with a new profile, because the terminal can't read Firefox's profiles.ini, which web-ext checks before reusing one. See the extension README.");
    },
  },
  // Manifest V3 for Firefox too. WXT builds Firefox as V2 by default, and V2
  // has no optional_host_permissions, so Weft could never ask for a network's
  // hosts there.
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: "Weft",
    description: "Identity wallet for Hyperledger Fabric. Sign transactions with your organisation's certificate.",
    // alarms: an hourly check for expiring certificates (lib/certificate-watch.ts).
    permissions: ["storage", "unlimitedStorage", "activeTab", "alarms"],
    // CA and relay hosts differ per organisation, so access is requested at
    // runtime, per host, when the user adds a network.
    optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
    ...(e2e ? { host_permissions: ["http://localhost/*", "http://127.0.0.1/*"] } : {}),
    action: { default_title: "Weft" },
    icons: { 16: "icon/16.png", 32: "icon/32.png", 48: "icon/48.png", 128: "icon/128.png" },
    // Firefox wants an add-on ID, and new add-ons must say what data they
    // collect: none, which needs Firefox 140.
    ...(browser === "firefox"
      ? { browser_specific_settings: { gecko: { id: "wallet@weft.ifeanyiugwu.dev", strict_min_version: "140.0", data_collection_permissions: { required: ["none"] } }, gecko_android: { strict_min_version: "142.0" } } }
      : {}),
  }),
});
