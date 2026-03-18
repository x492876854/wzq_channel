import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";

/**
 * 单个账户的原始配置（来自 config.json5 中 channels.wzq-channel）
 */
export type MyWsChannelConfig = {
  enabled?: boolean;
  /** WebSocket 服务器地址，例如 ws://your-server:8080/chat */
  wsUrl?: string;
  /** 可选的鉴权 token，将以 Bearer 方式放入 Authorization 请求头 */
  token?: string;
  /** 图片下载地址 */
  fileUrl?: string;

  /** 允许接收消息的发送者 ID 列表 */
  allowFrom?: string[];
  /** 默认发送目标 */
  defaultTo?: string;
  /** 多账户配置 */
  accounts?: Record<string, Omit<MyWsChannelConfig, "accounts">>;
};

/**
 * 解析后的账户对象，供 ChannelPlugin 各处使用
 */
export type ResolvedMyWsAccount = {
  accountId: string;
  wsUrl: string;
  token: string | undefined;
  fileUrl: string;
  enabled: boolean;
  configured: boolean;
  config: MyWsChannelConfig;
};

function getRootConfig(cfg: OpenClawConfig): MyWsChannelConfig | undefined {
  return (cfg.channels as Record<string, MyWsChannelConfig> | undefined)?.["wzq-channel"];
}

export function listMyWsAccountIds(cfg: OpenClawConfig): string[] {
  const root = getRootConfig(cfg);
  if (!root) return [];
  const subAccounts = Object.keys(root.accounts ?? {});
  return subAccounts.length > 0 ? subAccounts : [DEFAULT_ACCOUNT_ID];
}

export function resolveMyWsAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedMyWsAccount {
  const root = getRootConfig(cfg);
  const resolvedId = accountId ?? DEFAULT_ACCOUNT_ID;

  // 多账户模式：从 accounts[accountId] 读取，回退到顶层
  const accountCfg: MyWsChannelConfig =
    (root?.accounts?.[resolvedId] as MyWsChannelConfig | undefined) ?? root ?? {};

  const wsUrl = accountCfg.wsUrl?.trim() ?? "";
  const token = accountCfg.token?.trim() || undefined;
  const fileUrl = accountCfg.fileUrl.trim() ?? "";
  const enabled = accountCfg.enabled !== false;
  const configured = Boolean(wsUrl);

  return {
    accountId: resolvedId,
    wsUrl,
    token,
    fileUrl,
    enabled,
    configured,
    config: accountCfg,
  };
}
