import { getActiveWs } from "./monitor.js";
import { getMyWsRuntime } from "./runtime.js";

export type SendMyWsMessageOptions = {
  accountId: string;
  to: string;
  text: string;
};

export type SendMyWsMessageResult = {
  messageId: string;
  chatId: string;
};

/**
 * 通过已建立的 WebSocket 连接发送出站消息。
 * 可根据实际服务器协议调整此处的序列化格式。
 */
export async function sendMyWsMessage(
  opts: SendMyWsMessageOptions,
): Promise<SendMyWsMessageResult> {
  const { accountId, to, text } = opts;
  const ws = getActiveWs(accountId);

  if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) {
    throw new Error(
      `[wzq-channel] 账户 "${accountId}" 的 WebSocket 连接未就绪（readyState=${ws?.readyState ?? "无连接"}）`,
    );
  }

  const messageId = `ws-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  ws.send(
    JSON.stringify({
      content_type: "text",
      content: text,
    }),
  );

  // 记录出站活动
  const core = getMyWsRuntime();
  core.channel.activity.record({
    channel: "wzq-channel",
    accountId,
    direction: "outbound",
    at: Date.now(),
  });

  return { messageId, chatId: to };
}


/**
 * 通过已建立的 WebSocket 连接发送出站消息。
 * 可根据实际服务器协议调整此处的序列化格式。
 */
export async function sendProcessing(
  opts: SendMyWsMessageOptions,
): Promise<SendMyWsMessageResult> {
  const { accountId, to, text } = opts;
  const ws = getActiveWs(accountId);

  if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) {
    throw new Error(
      `[wzq-channel] 账户 "${accountId}" 的 WebSocket 连接未就绪（readyState=${ws?.readyState ?? "无连接"}）`,
    );
  }

  const messageId = `ws-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  ws.send(
    JSON.stringify({
      content_type: "processing",
      content: text
    }),
  );
  return { messageId, chatId: to };
}
