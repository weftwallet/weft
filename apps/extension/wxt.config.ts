import { defineConfig } from "wxt";

// https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Weft",
    description: "Identity wallet for Hyperledger Fabric. Sign transactions with your organisation's certificate.",
    // alarms: an hourly check for expiring certificates (lib/certificate-watch.ts).
    permissions: ["storage", "unlimitedStorage", "activeTab", "alarms"],
    // CA and relay hosts differ per organisation, so access is requested at
    // runtime, per host, when the user adds a network.
    optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
    action: { default_title: "Weft" },
    icons: { 16: "icon/16.png", 32: "icon/32.png", 48: "icon/48.png", 128: "icon/128.png" },
  },
});
