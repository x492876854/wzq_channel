import {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  getChatChannelMeta,
  missingTargetError,
  PAIRING_APPROVED_MESSAGE,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import {
  listMyWsAccountIds,
  resolveMyWsAccount,
  type ResolvedMyWsAccount,
} from "./accounts.js";
import { startMyWsMonitor } from "./monitor.js";
import { getMyWsRuntime } from "./runtime.js";
import { sendMyWsMessage } from "./send.js";

const meta = getChatChannelMeta("wzq-channel");

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

export const myWsPlugin: ChannelPlugin<ResolvedMyWsAccount> = {
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
  configSchema: buildChannelConfigSchema({}),

  // ── 账户配置解析 ──────────────────────────────────────────
  config: {
    listAccountIds: (cfg) => listMyWsAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveMyWsAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "wzq-channel",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "wzq-channel",
        accountId,
        clearBaseFields: ["wsUrl", "token", "fileUrl", "allowFrom", "defaultTo"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      wsUrl: account.wsUrl,
      fileUrl: account.fileUrl
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveMyWsAccount(cfg, accountId).config.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map(formatAllowFromEntry),
    resolveDefaultTo: ({ cfg, accountId }) =>
      resolveMyWsAccount(cfg, accountId).config.defaultTo?.trim() || undefined,
  },

  // ── 安全策略 ──────────────────────────────────────────────
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
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
        approveHint: formatPairingApproveHint("wzq-channel"),
        normalizeEntry: (raw) => formatAllowFromEntry(raw),
      };
    },
    collectWarnings: () => [],
  },

  // ── Pairing（配对）────────────────────────────────────────
  pairing: {
    idLabel: "wsUserId",
    normalizeAllowEntry: (entry) => formatAllowFromEntry(entry),
    notifyApproval: async ({ cfg, id }) => {
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
    normalizeTarget: (raw) => normalizeTarget(raw),
    targetResolver: {
      looksLikeId: (raw, normalized) => Boolean(normalized ?? raw.trim()),
      hint: "<userId>",
    },
  },

  // ── 目标解析器 ────────────────────────────────────────────
  resolver: {
    resolveTargets: async ({ inputs }) => {
      return inputs.map((input) => {
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
    listPeers: async ({ cfg, accountId, query, limit }) => {
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
    chunker: (text, limit) => getMyWsRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 40000,
    resolveTarget: ({ to }) => {
      console.log("resolveTarget")
      return { ok: true, to: "default" };
    },
    sendText: async ({ cfg, to, text, accountId }) => {
      console.log("sendText")
      const account = resolveMyWsAccount(cfg, accountId);
      const result = await sendMyWsMessage({
        accountId: account.accountId,
        to,
        text,
      });
      return {
        channel: "wzq-channel",
        messageId: result.messageId,
        chatId: result.chatId,
      };
    },
    sendMedia: async ({ cfg, to, accountId }) => {
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
    buildChannelSummary: ({ snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      ...buildBaseAccountStatusSnapshot({ account, runtime }),
      wsUrl: account.wsUrl,
    }),
  },

  // ── Gateway：WebSocket 长连接入站监听 ─────────────────────
  gateway: {
    startAccount: async (ctx) => {
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
        statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });
    },
  },
};
