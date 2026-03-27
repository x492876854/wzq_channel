import { myWsPlugin } from "./src/channel.js";
import { setMyWsRuntime } from "./src/runtime.js";

// ── 新版 SDK：优先使用 defineChannelPluginEntry ──────────────
let defineChannelPluginEntry: any;
try {
  defineChannelPluginEntry = require("openclaw/plugin-sdk/core").defineChannelPluginEntry;
} catch {}

// ── 旧版 SDK fallback ───────────────────────────────────────
let emptyPluginConfigSchema: (() => any) | undefined;
try {
  const sdk = require("openclaw/plugin-sdk");
  emptyPluginConfigSchema = sdk.emptyPluginConfigSchema;
} catch {}

let plugin: any;

if (typeof defineChannelPluginEntry === "function") {
  // ── 新版路径：使用声明式入口 ─────────────────────────────
  plugin = defineChannelPluginEntry({
    id: "wzq-channel",
    name: "Wzq Channel",
    description: "通过 WebSocket 与自定义服务器通信的 OpenClaw channel 插件",
    plugin: myWsPlugin,
    registerFull(api: any) {
      setMyWsRuntime(api.runtime);
    },
  });
} else {
  // ── 旧版 fallback：手动注册 ─────────────────────────────
  plugin = {
    id: "wzq-channel",
    name: "Wzq Channel",
    description: "通过 WebSocket 与自定义服务器通信的 OpenClaw channel 插件",
    configSchema: typeof emptyPluginConfigSchema === "function"
      ? emptyPluginConfigSchema()
      : { type: "object", properties: {} },
    register(api: any) {
      setMyWsRuntime(api.runtime);
      api.registerChannel({ plugin: myWsPlugin });
    },
  };
}

export default plugin;
