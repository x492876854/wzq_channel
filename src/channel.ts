// ── 兼容新旧版 openclaw SDK ──────────────────────────────────
// 新版 SDK 将导入路径细分为 openclaw/plugin-sdk/<subpath>
// 旧版 SDK 从 openclaw/plugin-sdk 根路径导出
// 这里依次尝试新版子路径 → 旧版根路径 → 内置 fallback

// --- SDK 辅助函数声明 ---
let createChatChannelPlugin: any;
let createChannelPluginBase: any;
let buildBaseAccountStatusSnapshot: any;
let buildBaseChannelStatusSummary: any;
let buildChannelConfigSchema: any;
let DEFAULT_ACCOUNT_ID: string = "default";
let deleteAccountFromConfigSection: any;
let formatPairingApproveHint: any;
let getChatChannelMeta: any;
let missingTargetError: any;
let PAIRING_APPROVED_MESSAGE: string = "Pairing approved ✓";
let setAccountEnabledInConfigSection: any;

// 尝试新版子路径导入
try {
  const core = require("openclaw/plugin-sdk/core");
  createChatChannelPlugin = core.createChatChannelPlugin;
  createChannelPluginBase = core.createChannelPluginBase;
  if (core.DEFAULT_ACCOUNT_ID != null) DEFAULT_ACCOUNT_ID = core.DEFAULT_ACCOUNT_ID;
} catch {}

try {
  const helpers = require("openclaw/plugin-sdk/channel-config-helpers");
  buildChannelConfigSchema = helpers.buildChannelConfigSchema ?? helpers.createHybridChannelConfigAdapter;
  deleteAccountFromConfigSection = helpers.deleteAccountFromConfigSection;
  setAccountEnabledInConfigSection = helpers.setAccountEnabledInConfigSection;
} catch {}

try {
  const lifecycle = require("openclaw/plugin-sdk/channel-lifecycle");
  buildBaseAccountStatusSnapshot = lifecycle.buildBaseAccountStatusSnapshot ?? lifecycle.createAccountStatusSink;
  buildBaseChannelStatusSummary = lifecycle.buildBaseChannelStatusSummary;
} catch {}

try {
  const schema = require("openclaw/plugin-sdk/channel-config-schema");
  if (!buildChannelConfigSchema) buildChannelConfigSchema = schema.buildChannelConfigSchema;
} catch {}

try {
  const pairing = require("openclaw/plugin-sdk/channel-pairing");
  formatPairingApproveHint = pairing.formatPairingApproveHint;
  if (pairing.PAIRING_APPROVED_MESSAGE != null) PAIRING_APPROVED_MESSAGE = pairing.PAIRING_APPROVED_MESSAGE;
} catch {}

// 旧版根路径 fallback（兼容未迁移的环境）
try {
  const sdk = require("openclaw/plugin-sdk");
  if (!buildBaseAccountStatusSnapshot) buildBaseAccountStatusSnapshot = sdk.buildBaseAccountStatusSnapshot;
  if (!buildBaseChannelStatusSummary) buildBaseChannelStatusSummary = sdk.buildBaseChannelStatusSummary;
  if (!buildChannelConfigSchema) buildChannelConfigSchema = sdk.buildChannelConfigSchema;
  if (sdk.DEFAULT_ACCOUNT_ID != null && DEFAULT_ACCOUNT_ID === "default") DEFAULT_ACCOUNT_ID = sdk.DEFAULT_ACCOUNT_ID;
  if (!deleteAccountFromConfigSection) deleteAccountFromConfigSection = sdk.deleteAccountFromConfigSection;
  if (!formatPairingApproveHint) formatPairingApproveHint = sdk.formatPairingApproveHint;
  if (!getChatChannelMeta) getChatChannelMeta = sdk.getChatChannelMeta;
  if (!missingTargetError) missingTargetError = sdk.missingTargetError;
  if (sdk.PAIRING_APPROVED_MESSAGE != null && PAIRING_APPROVED_MESSAGE === "Pairing approved ✓") {
    PAIRING_APPROVED_MESSAGE = sdk.PAIRING_APPROVED_MESSAGE;
  }
  if (!setAccountEnabledInConfigSection) setAccountEnabledInConfigSection = sdk.setAccountEnabledInConfigSection;
} catch {}

import {
  listMyWsAccountIds,
  resolveMyWsAccount,
  type ResolvedMyWsAccount,
} from "./accounts.js";
import { startMyWsMonitor, callGateway } from "./monitor.js";
import { getMyWsRuntime } from "./runtime.js";
import { sendMyWsMessage } from "./send.js";

// 兼容：getChatChannelMeta 在新版 SDK 中可能已移入 core 或不再存在
const meta = typeof getChatChannelMeta === "function"
  ? getChatChannelMeta("wzq-channel")
  : {
      id: "wzq-channel",
      label: "wzq-channel",
      selectionLabel: "wzq-channel",
    };

/**
 * 规范化 allowFrom 条目：去除空白和可选的 "wzq-channel:" 前缀
 */
const formatAllowFromEntry = (entry: string): string =>
  entry
    .trim()
    .replace(/^wzq-channel:/i, "")
    .toLowerCase();

/**
 * 规范化消息目标（to 字段），去除空白
 */
function normalizeTarget(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed || null;
}

export const myWsPlugin: any = {
  id: "wzq-channel",
  meta: {
    ...meta,
    // 覆盖 meta 中自动生成的标签，使其更友好
    label: "My WebSocket",
    selectionLabel: "My WebSocket Channel",
  },

  // ── 能力声明 ──────────────────────────────────────────────
  capabilities: {
    chatTypes: ["direct"],
    media: true,
    blockStreaming: true,
  },

  // ── 配置热重载触发前缀 ────────────────────────────────────
  reload: { configPrefixes: ["channels.wzq-channel"] },

  // ── 配置 Schema（无额外插件级配置，使用空 schema）────────
  configSchema: typeof buildChannelConfigSchema === "function"
    ? buildChannelConfigSchema({})
    : { type: "object", properties: {} },

  // ── 账户配置解析 ──────────────────────────────────────────
  config: {
    listAccountIds: (cfg: any) => listMyWsAccountIds(cfg),
    resolveAccount: (cfg: any, accountId: any) => resolveMyWsAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: typeof setAccountEnabledInConfigSection === "function"
      ? ({ cfg, accountId, enabled }: any) =>
          setAccountEnabledInConfigSection({
            cfg,
            sectionKey: "wzq-channel",
            accountId,
            enabled,
            allowTopLevel: true,
          })
      : ({ cfg }: any) => cfg,
    deleteAccount: typeof deleteAccountFromConfigSection === "function"
      ? ({ cfg, accountId }: any) =>
          deleteAccountFromConfigSection({
            cfg,
            sectionKey: "wzq-channel",
            accountId,
            clearBaseFields: ["wsUrl", "token", "fileUrl", "allowFrom", "defaultTo"],
          })
      : ({ cfg }: any) => cfg,
    isConfigured: (account: any) => account.configured,
    describeAccount: (account: any) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      wsUrl: account.wsUrl,
      fileUrl: account.fileUrl
    }),
    resolveAllowFrom: ({ cfg, accountId }: any) =>
      (resolveMyWsAccount(cfg, accountId).config.allowFrom ?? []).map((entry: any) => String(entry)),
    formatAllowFrom: ({ allowFrom }: any) =>
      allowFrom
        .map((entry: any) => String(entry))
        .filter(Boolean)
        .map(formatAllowFromEntry),
    resolveDefaultTo: ({ cfg, accountId }: any) =>
      resolveMyWsAccount(cfg, accountId).config.defaultTo?.trim() || undefined,
  },

  // ── 安全策略 ──────────────────────────────────────────────
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }: any) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(
        (cfg.channels as Record<string, { accounts?: Record<string, unknown> }> | undefined)?.[
          "wzq-channel"
        ]?.accounts?.[resolvedAccountId],
      );
      const basePath = useAccountPath
        ? `channels.wzq-channel.accounts.${resolvedAccountId}.`
        : "channels.wzq-channel.";
      return {
        policy: "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
        approveHint: typeof formatPairingApproveHint === "function"
          ? formatPairingApproveHint("wzq-channel")
          : "Approve pairing for wzq-channel",
        normalizeEntry: (raw: any) => formatAllowFromEntry(raw),
      };
    },
    collectWarnings: () => [],
  },

  // ── Pairing（配对）────────────────────────────────────────
  pairing: {
    idLabel: "wsUserId",
    normalizeAllowEntry: (entry: any) => formatAllowFromEntry(entry),
    notifyApproval: async ({ cfg, id }: any) => {
      const account = resolveMyWsAccount(cfg);
      if (!account.configured) return;
      await sendMyWsMessage({
        accountId: account.accountId,
        to: id,
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },

  // ── 消息目标规范化 ────────────────────────────────────────
  messaging: {
    normalizeTarget: (raw: any) => normalizeTarget(raw),
    targetResolver: {
      looksLikeId: (raw: any, normalized: any) => Boolean(normalized ?? raw.trim()),
      hint: "<userId>",
    },
  },

  // ── 目标解析器 ────────────────────────────────────────────
  resolver: {
    resolveTargets: async ({ inputs }: any) => {
      return inputs.map((input: any) => {
        const normalized = normalizeTarget(input);
        if (!normalized) {
          return { input, resolved: false as const, note: "目标 ID 不能为空" };
        }
        return { input, resolved: true as const, id: normalized };
      });
    },
  },

  // ── 目录（联系人列表）────────────────────────────────────
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }: any) => {
      const account = resolveMyWsAccount(cfg, accountId);
      const q = query?.trim().toLowerCase() ?? "";
      const ids = new Set<string>();
      for (const entry of account.config.allowFrom ?? []) {
        const normalized = formatAllowFromEntry(String(entry));
        if (normalized && normalized !== "*") {
          ids.add(normalized);
        }
      }
      return Array.from(ids)
        .filter((id) => (q ? id.includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user" as const, id }));
    },
    listGroups: async () => [],
  },

  // ── 出站消息发送 ──────────────────────────────────────────
  outbound: {
    deliveryMode: "direct",
    chunker: (text: any, limit: any) => getMyWsRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 40000,
    resolveTarget: ({ to }: any) => {
      console.log("resolveTarget")
      return { ok: true, to: "default" };
    },
    sendText: async ({ cfg, to, text, accountId }: any) => {
      console.log("sendText", text)
      const account = resolveMyWsAccount(cfg, accountId);
      const result = await sendMyWsMessage({
        accountId: account.accountId,
        to,
        text,
        reply_id: "system",
      });

      // 将 text 注入到 agent 的 session 中
      const sessionKey = "agent:main:wzq-channel:direct:zxgmain";
      try {
        await callGateway("chat.inject", {
          sessionKey,
          message: text,
        });
        console.log(`[sendText] 已注入消息到 session: ${sessionKey}`);
      } catch (err) {
        console.error(`[sendText] 注入消息到 session 失败: ${err}`);
      }

      return {
        channel: "wzq-channel",
        messageId: result.messageId,
        chatId: result.chatId,
      };
    },
    sendMedia: async ({ cfg, to, accountId }: any) => {
      console.log("sendMedia")
      // 先不支持发送媒体资源
      return {
        channel: "wzq-channel",
      };
    }
  },

  // ── 状态管理 ──────────────────────────────────────────────
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }: any) => ({
      ...(typeof buildBaseChannelStatusSummary === "function"
        ? buildBaseChannelStatusSummary(snapshot)
        : snapshot),
    }),
    buildAccountSnapshot: ({ account, runtime }: any) => ({
      ...(typeof buildBaseAccountStatusSnapshot === "function"
        ? buildBaseAccountStatusSnapshot({ account, runtime })
        : { account, runtime }),
      wsUrl: account.wsUrl,
    }),
  },

  // ── Gateway：WebSocket 长连接入站监听 ─────────────────────
  gateway: {
    startAccount: async (ctx: any) => {
      const { account, } = ctx;
      if (!account.configured) {
        throw new Error(
          `wzq-channel 账户 "${account.accountId}" 未配置，` +
            `请在 channels.wzq-channel.wsUrl 中设置 WebSocket 服务器地址。`,
        );
      }

      // ctx.log?.info(`[${account.accountId}] 正在启动 WebSocket 连接: ${account.wsUrl}`);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
      });

      await startMyWsMonitor({
        account,
        cfg: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch: any) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });
    },
  },
};
