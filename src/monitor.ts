// ── 兼容新旧版 openclaw SDK ──────────────────────────────────
let buildAgentMediaPayload: any;
try {
  const replyPayload = require("openclaw/plugin-sdk/reply-payload");
  buildAgentMediaPayload = replyPayload.buildAgentMediaPayload;
} catch {}
if (!buildAgentMediaPayload) {
  try {
    const sdk = require("openclaw/plugin-sdk");
    buildAgentMediaPayload = sdk.buildAgentMediaPayload;
  } catch {}
}
import WebSocket from "ws";
import type { ResolvedMyWsAccount } from "./accounts.js";
import { getMyWsRuntime } from "./runtime.js";
import {sendMyWsMessage, sendProcessing, sendDone, sendControl} from "./send";
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');


type QueueItem = {
  task: () => Promise<void>;
  meta: { sid: string; mid: string };
};

/**
 * 简单的异步串行队列：确保同一时间只处理一个任务，
 * 后续任务排队等待，按入队顺序依次执行。
 */
class AsyncQueue {
  private queue: QueueItem[] = [];
  private running = false;

  enqueue(task: () => Promise<void>, meta: { sid: string; mid: string }) {
    this.queue.push({ task, meta });
    if (!this.running) {
      this.run();
    }
  }

  /** 清空队列中所有待执行的任务（不影响正在执行的任务），返回被清掉任务的元信息 */
  clear(): { sid: string; mid: string }[] {
    const cleared = this.queue.map((item) => item.meta);
    this.queue = [];
    return cleared;
  }

  private async run() {
    this.running = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        await item.task();
      } catch (err) {
        console.error("[AsyncQueue] 任务执行异常:", err);
      }
    }
    this.running = false;
  }
}

/** 消息处理串行队列 */
const messageQueue = new AsyncQueue();

/**
 * 每个消息维护一个 AbortController（key 为消息 id），
 * 前端通过 control 命令 { method: "chat.stop" } 来停止当前生成并清空队列。
 */
const messageAbortControllers = new Map<string, AbortController>();

/**
 * chat.stop 已为这些消息 id 提前发送了 done，
 * 任务结束时不再重复发送。
 */
const doneSentByStop = new Set<string>();

/**
 * 追踪当前正在进行的 gateway chat.abort 调用。
 * 新消息在开始 AI 调用前必须等待此 Promise 完成，
 * 避免 chat.abort 异步到达 gateway 时误杀新消息的生成。
 */
let pendingAbortPromise: Promise<void> | null = null;

/**
 * 活跃的 WebSocket 连接表，key 为 accountId
 * 供 send.ts 发送出站消息时使用
 */
const activeConnections = new Map<string, WebSocket>();

export function getActiveWs(accountId: string): WebSocket | undefined {
  return activeConnections.get(accountId);
}

export type MonitorOptions = {
  account: ResolvedMyWsAccount;
  runtime: any;
  abortSignal: AbortSignal;
  statusSink: (patch: Record<string, unknown>) => void;
  cfg: unknown;
};



// 根据扩展名获取 MIME 类型（简单映射，可根据需要扩展）
function getMimeType(ext) {
  const mimeMap = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
  };
  return mimeMap[ext.toLowerCase()] || 'application/octet-stream';
}

// 同步方式生成 Data URL
function imageToDataURL(filePath) {
  try {
    const imageBuffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    const mimeType = getMimeType(ext);
    const base64String = imageBuffer.toString('base64');
    return `data:${mimeType};base64,${base64String}`;
  } catch (error) {
    console.error('转换失败:', error);
    return null;
  }
}

/**
 * 读取 openclaw gateway 配置（端口、token）
 */
export function readGatewayConfig(): { port: number; token: string } {
  let port = 18789;
  let token = '';
  try {
    const configFile = path.join(process.env.HOME || '~', '.openclaw', 'openclaw.json');
    let rawConfig = fs.readFileSync(configFile, 'utf-8');
    // 移除单行注释 (// ...)，但不影响字符串内的 // (如 URL、sha512 等)
    rawConfig = rawConfig.replace(/^((?:[^"]*"(?:[^"\\]|\\.)*")*[^"]*)\/\/.*$/gm, '$1');
    const config = JSON.parse(rawConfig);
    port = config.gateway?.port ?? 18789;
    token = config.gateway?.auth?.token ?? '';
  } catch (err) {
    console.warn(`[gateway] 读取 openclaw 配置失败，使用默认端口: ${err}`);
  }
  return { port, token };
}

/**
 * 通用 gateway RPC 调用
 * 连接 gateway WS → challenge-response 认证 → 发送指定方法 → 返回 payload
 */
export function callGateway(method: string, params: Record<string, any> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const { port: gatewayPort, token: gatewayToken } = readGatewayConfig();
    const gwUrl = `ws://127.0.0.1:${gatewayPort}`;
    const gwWs: any = new WebSocket(gwUrl);
    let done = false;
    let connectReqId = '';
    let rpcReqId = '';

    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        gwWs.close();
        reject(new Error(`gateway 请求超时 (10s): ${method}`));
      }
    }, 10_000);

    const finish = (result?: any, error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      gwWs.close();
      if (error) reject(error);
      else resolve(result);
    };

    gwWs.on('open', () => {
      console.log(`[gateway] 已连接 ${gwUrl}，准备调用 ${method}`);
    });

    gwWs.on('message', (data: any) => {
      try {
        const msg = JSON.parse(String(data));

        // 步骤1: 收到 challenge，回复 connect 请求
        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          connectReqId = crypto.randomUUID();
          gwWs.send(JSON.stringify({
            type: 'req',
            id: connectReqId,
            method: 'connect',
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: 'gateway-client',
                displayName: 'wzq-channel',
                version: '1.0.0',
                platform: process.platform,
                mode: 'backend',
              },
              caps: [],
              auth: gatewayToken ? { token: gatewayToken } : undefined,
              role: 'operator',
              scopes: ['operator.admin'],
            },
          }));
          return;
        }

        // 步骤2: connect 响应成功，发送 RPC 请求
        if (msg.type === 'res' && msg.id === connectReqId) {
          if (!msg.ok) {
            finish(undefined, new Error(`gateway 认证失败: ${msg.error?.message || JSON.stringify(msg.error)}`));
            return;
          }
          rpcReqId = crypto.randomUUID();
          gwWs.send(JSON.stringify({
            type: 'req',
            id: rpcReqId,
            method,
            params,
          }));
          return;
        }

        // 步骤3: RPC 响应
        if (msg.type === 'res' && msg.id === rpcReqId) {
          if (!msg.ok) {
            finish(undefined, new Error(`${method} 失败: ${msg.error?.message || JSON.stringify(msg.error)}`));
            return;
          }
          finish(msg.payload);
          return;
        }

        // 忽略其他事件（tick 等）
      } catch (err) {
        finish(undefined, new Error(`解析 gateway 消息失败: ${err}`));
      }
    });

    gwWs.on('error', (err: any) => {
      finish(undefined, new Error(`gateway 连接错误: ${err.message}`));
    });

    gwWs.on('close', () => {
      if (!done) {
        finish(undefined, new Error('gateway 连接意外关闭'));
      }
    });
  });
}

/**
 * 启动 WebSocket 长连接监听，入站消息通过 runtime.channel.inbound.dispatch 分发给 agent。
 * 返回 { stop } 供 gateway 在 abort 时调用。
 */
export async function startMyWsMonitor(opts: MonitorOptions): Promise<{ stop: () => void }> {

  const { account, runtime, abortSignal, statusSink, cfg } = opts;
  const core = getMyWsRuntime();
  const logger = core.logging.getChildLogger({
    channel: "wzq-channel",
    accountId: account.accountId,
  });

  logger.info?.("正在启动 WebSocket 连接");

  let stopped = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // ── 心跳保活 ──────────────────────────────────────────────────────────────
  // 每隔 HEARTBEAT_INTERVAL 毫秒发送一次 ping；
  // 若在 HEARTBEAT_TIMEOUT 毫秒内未收到 pong，则主动关闭连接触发重连。
  const HEARTBEAT_INTERVAL = 10_000; // 10 秒发一次 ping
  const HEARTBEAT_TIMEOUT  = 10_000; // 10 秒内必须收到 pong

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let waitingForPong = false;

  function clearHeartbeat() {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (pongTimeoutTimer !== null) {
      clearTimeout(pongTimeoutTimer);
      pongTimeoutTimer = null;
    }
    waitingForPong = false;
  }

  function startHeartbeat(socket: WebSocket) {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        console.log('socket readystate no open')
        clearHeartbeat();
        return;
      }
      if (waitingForPong) {
        // 上一次 ping 还没收到 pong，连接可能已僵死
        logger.warn?.(`[${account.accountId}] 心跳超时，主动断开连接并重连`);
        clearHeartbeat();
        socket.terminate(); // 强制关闭，触发 close 事件 → 重连
        return;
      }
      waitingForPong = true;
      socket.ping();
      // console.log('socket send pin')
      // 启动 pong 超时计时器
      pongTimeoutTimer = setTimeout(() => {
        if (waitingForPong) {
          logger.warn?.(`[${account.accountId}] pong 响应超时，主动断开连接并重连`);
          clearHeartbeat();
          socket.terminate();
        }
      }, HEARTBEAT_TIMEOUT);
    }, HEARTBEAT_INTERVAL);
  }

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function connect() {
    if (stopped || abortSignal.aborted) {
      logger.info?.(`[${account.accountId}] 跳过重连：已停止或已中止`);
      return;
    }

    // 清理旧的 WebSocket 连接和事件处理器
    if (ws) {
      try {
        ws.removeAllListeners();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch (err) {
        // 忽略清理错误
      }
      ws = null;
    }

    logger.info?.(`[${account.accountId}] 正在连接 WebSocket: ${account.wsUrl}`);

    try {
      const reqUrl = account.wsUrl + "?conntoken=" + account.token
      console.log("wzq websocket url: " + reqUrl)
      ws = new WebSocket(reqUrl, {
        headers: account.token ? { Authorization: `Bearer ${account.token}` } : {},
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error?.(`[${account.accountId}] 创建 WebSocket 连接失败: ${errorMsg}`);
      statusSink({ connected: false, lastError: errorMsg });
      // 连接创建失败，3 秒后重试
      if (!stopped && !abortSignal.aborted) {
        reconnectTimer = setTimeout(connect, 3000);
      }
      return;
    }

    ws.on("open", () => {
      logger.info?.(`[${account.accountId}] WebSocket 连接已建立`);
      activeConnections.set(account.accountId, ws!);
      statusSink({ running: true, connected: true, lastError: null });
      // 连接建立后启动心跳
      startHeartbeat(ws!);
      // 清除重连定时器（连接成功）
      clearReconnectTimer();
    });

    ws.on("pong", () => {
      // 收到服务器 pong，清除超时计时器，标记已响应
      // console.log("socket get pong")
      if (pongTimeoutTimer !== null) {
        clearTimeout(pongTimeoutTimer);
        pongTimeoutTimer = null;
      }
      waitingForPong = false;
      // 通知 gateway 健康监控：连接仍然活跃
      statusSink({ lastEventAt: Date.now() });
    });

    ws.on("message", (data) => {
      // ── 先解析消息，control 类型不排队，直接异步处理 ──────────────
      let msg: {
        session_id?: string;
        content_type?: string;
        content?: string;
        id?: string;
      };
      try {
        msg = JSON.parse(String(data));
      } catch {
        logger.warn?.(`[${account.accountId}] 消息 JSON 解析失败，忽略`);
        return;
      }

      const sid = msg.session_id ?? "unknown";
      const mid = msg.id ?? "unknown";
      const logTag = `[${account.accountId}][sid=${sid}][mid=${mid}]`;

      // ── 处理 control 类型消息：不排队，立即执行 ─────────────────
      if (msg.content_type === "control") {
        (async () => {
          let ctrl: { method?: string; params?: Record<string, any> } = {};
          try {
            ctrl = msg.content ? JSON.parse(msg.content) : {};
          } catch {
            logger.warn?.(`${logTag} [control] content 解析失败，忽略`);
            return;
          }
          const { method, params = {} } = ctrl;
          if (!method) {
            logger.warn?.(`${logTag} [control] 缺少 method 字段，忽略`);
            return;
          }
          logger.info?.(`${logTag} [control] 收到指令: ${method}`);

          // ── chat.stop：停止当前生成 + 清空队列 ────────────────
          if (method === "chat.stop") {
            // 先清空队列，收集待清理信息
            const clearedItems = messageQueue.clear();
            // 收集正在执行中的消息 id（用于给它们也发 done）
            const runningMids = Array.from(messageAbortControllers.keys());
            const abortedCount = runningMids.length;
            logger.info?.(`${logTag} [control] chat.stop: 将中止 ${abortedCount} 个任务, 清空队列 ${clearedItems.length} 个待执行任务`);

            // 先发送所有 done + control 消息，不等待结果（fire-and-forget）
            Promise.all([
              // 被清掉的队列任务的 done
              ...clearedItems.map((item) =>
                sendDone({
                  accountId: account.accountId,
                  to: `wzq-channel:${item.sid}`,
                  text: "已停止",
                  reply_id: item.mid,
                }),
              ),
              // 正在执行中的消息的 done（不等 AI 调用结束，立即发）
              ...runningMids.map((runningMid) =>
                sendDone({
                  accountId: account.accountId,
                  to: `wzq-channel:${sid}`,
                  text: "已停止",
                  reply_id: runningMid,
                }),
              ),
              // 当前 chat.stop 消息的 done
              sendDone({
                accountId: account.accountId,
                to: `wzq-channel:${sid}`,
                text: "已停止",
                reply_id: mid,
              }),
              // control 响应
              sendControl({
                accountId: account.accountId,
                to: `wzq-channel:${sid}`,
                reply_id: mid,
                text: JSON.stringify({ method, data: { stopped: true, abortedCount, clearedQueue: clearedItems.length } }),
              }),
            ]).catch((err) => {
              logger.warn?.(`${logTag} [control] chat.stop 发送消息失败（不影响停止）: ${String(err)}`);
            });

            // 标记这些消息的 done 已由 chat.stop 发出，任务结束时不再重复发
            for (const runningMid of runningMids) {
              doneSentByStop.add(runningMid);
            }

            // 再 abort 所有正在进行的消息
            for (const [id, controller] of messageAbortControllers) {
              logger.info?.(`${logTag} [control] 正在停止消息 id=${id} 的生成`);
              controller.abort();
            }
            return;
          }

          // ── 其他 control 方法：转发到 gateway ────────────────────
          try {
            const payload = await callGateway(method, params);
            logger.info?.(`${logTag} [control] ${method} 调用成功`);
            await sendControl({
              accountId: account.accountId,
              to: msg.session_id ?? "",
              reply_id: mid,
              text: JSON.stringify({ method, data: payload }),
            });
          } catch (err) {
            logger.error(`${logTag} [control] ${method} 调用失败: ${String(err)}`);
            await sendControl({
              accountId: account.accountId,
              to: msg.session_id ?? "",
              reply_id: mid,
              text: JSON.stringify({ method, error: String(err) }),
            });
          }
        })();
        return;
      }

      // ── 非 control 消息：进入串行队列 ──────────────────────────
      messageQueue.enqueue(async () => {
      // 注册本消息的 AbortController，前端可通过 chat.stop 中断
      const currentAbort = new AbortController();
      messageAbortControllers.set(mid, currentAbort);

      try {
        // 记录入站活动
        core.channel.activity.record({
          channel: "wzq-channel",
          accountId: account.accountId,
          direction: "inbound",
          at: Date.now(),
        });
        statusSink({ lastInboundAt: Date.now(), lastEventAt: Date.now() });

        if (!msg.session_id) {
          logger.warn?.(`[${account.accountId}] 收到格式不符的消息，已忽略: ${String(data)}`);
          return;
        }

        if (!msg.content) {
          logger.warn?.(`[${account.accountId}] 收到格式不符的消息，已忽略: ${String(data)}`);
          return;
        }
        logger.info?.(`${logTag} 收到消息, content=${msg.content}`);
        // 处理图片媒体（参考飞书插件 bot.ts 的标准做法）
        // 使用 core.channel.media.saveMediaBuffer 保存到 openclaw 允许的目录
        const mediaList: Array<{ path: string; contentType: string; placeholder: string }> = [];
        if (msg.content.indexOf("image") !== -1) {
          const tmpMsgList = JSON.parse(msg.content)
          logger.info?.(`${logTag} 解析到图片列表`);
          let newTmpMsgList: any[] = [];
          for (const item of tmpMsgList) {
            if (item.type == 'image') {
              logger.info?.(`${logTag} 处理图片, image_id=${item.image_id}`);
              const baseUrl = account.fileUrl + "?token=" + account.token + "&image_id="
              const imageId = item.image_id;
              const imageUrl = baseUrl + imageId;
              logger.debug?.(`${logTag} 图片下载地址: ${imageUrl}`);
              try {
                // 下载图片到内存（Buffer）
                const response = await axios({
                  method: 'get',
                  url: imageUrl,
                  responseType: 'arraybuffer',
                });
                const buffer = Buffer.from(response.data);
                const contentType = response.headers['content-type'] || 'image/jpeg';
                logger.info?.(`${logTag} 图片下载成功, size=${buffer.length}, contentType=${contentType}`);

                // 使用 openclaw 核心 API 保存到允许的目录
                const saved = await core.channel.media.saveMediaBuffer(
                  buffer,
                  contentType,
                  "inbound",
                  30 * 1024 * 1024, // 30MB max
                );
                logger.info?.(`${logTag} 图片已保存到 openclaw 媒体目录: ${saved.path}`);

                mediaList.push({
                  path: saved.path,
                  contentType: saved.contentType,
                  placeholder: "<media:image>",
                });
              } catch (err) {
                logger.error(`${logTag} 下载/保存图片失败: ${String(err)}`);
              }
            } else {
              newTmpMsgList.push(item);
            }
          }
          logger.debug?.(`${logTag} 图片替换完成, newMsgList=${JSON.stringify(newTmpMsgList)}`);
          logger.debug?.(`${logTag} mediaList: ${JSON.stringify(mediaList)}`);
          msg.content = JSON.stringify(newTmpMsgList);
        }

        // 使用 buildAgentMediaPayload 构建标准媒体字段（兼容旧版 SDK）
        const mediaPayload = typeof buildAgentMediaPayload === "function"
          ? buildAgentMediaPayload(mediaList)
          : {};

        const session_id = msg.session_id // Date.now().toString()
        const route = core.channel.routing.resolveAgentRoute({
          cfg,
          channel: "wzq-channel",
          accountId: account.accountId,
          peer: {
            kind: "dm",
            id: session_id,
          },
        });
        const bodyText = msg.content;
        const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
        const body = core.channel.reply.formatInboundEnvelope({
          channel: "wzq-channel",
          from: account.accountId,
          timestamp: Date.now(),
          body: bodyText,
          chatType: "direct",
          sender: { id: session_id },
          envelope: envelopeOptions,
        });

        const address = `wzq-channel:${session_id}`;
        const ctxPayload = core.channel.reply.finalizeInboundContext({
          Body: body,
          RawBody: msg.content,
          CommandBody: bodyText,
          From: address,
          To: address,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: "direct",
          SenderId: session_id,
          Provider: "wzq-channel",
          Surface: "wzq-channel",
          MessageSid: Date.now().toString(),  // 消息id不能重
          Timestamp: Date.now(),
          OriginatingChannel: "wzq-channel",
          OriginatingTo: address,
          ...mediaPayload,
        });

        logger.info?.(`${logTag} 入站上下文构建完成`);

        try {
          const messagesConfig = core.channel.reply.resolveEffectiveMessagesConfig(
            cfg,
            route.agentId,
          );
          logger.info?.(`${logTag} 开始 AI 调用`);

          // 等待之前的 chat.abort 完成，避免异步到达的 abort 误杀新消息的 AI 生成
          if (pendingAbortPromise) {
            logger.info?.(`${logTag} 等待之前的 chat.abort 完成...`);
            await pendingAbortPromise;
            logger.info?.(`${logTag} 之前的 chat.abort 已完成`);
          }

          // 如果在开始 AI 调用前就已被 abort，直接跳过
          if (currentAbort.signal.aborted) {
            logger.info?.(`${logTag} AI 调用前已被 abort，跳过`);
            return;
          }

          // 发送思考中状态
          await sendProcessing({
            accountId: account.accountId,
            to: address,
            text: "思考中",
            reply_id: mid,
          })

          let deliverCount = 0;
          let lastDeliverTime = Date.now();
          const dispatchStartTime = lastDeliverTime;

          // 监听 abort 信号，通过 gateway chat.abort 中止底层 LLM 请求
          const onAbort = () => {
            const abortTask = (async () => {
              try {
                logger.info?.(`${logTag} 正在通过 gateway chat.abort 中止 AI 生成`);
                await callGateway("chat.abort", { sessionKey: route.sessionKey });
                logger.info?.(`${logTag} gateway chat.abort 调用成功`);
              } catch (err) {
                logger.warn?.(`${logTag} gateway chat.abort 调用失败: ${String(err)}`);
              }
            })();
            // 注册到全局，让后续新消息等待 abort 完成再开始 AI 调用
            const wrappedPromise = abortTask.finally(() => {
              // 只有当前 promise 仍是自己时才清空，避免覆盖更新的 abort
              if (pendingAbortPromise === wrappedPromise) {
                pendingAbortPromise = null;
              }
            });
            pendingAbortPromise = wrappedPromise;
          };

          // 如果已被 abort，给前端发送一条信息，成功结束
          if (currentAbort.signal.aborted) {
            logger.info?.(`${logTag} 任务开始前已被 abort，跳过 AI 调用`);
            await onAbort();
            await sendDone({
              accountId: account.accountId,
              to: address,
              text: "已停止",
              reply_id: mid,
            });
            return;
          }

          currentAbort.signal.addEventListener("abort", () => { onAbort(); }, { once: true });

          logger.info?.(`${logTag} 即将调用 dispatchReplyWithBufferedBlockDispatcher, aborted=${currentAbort.signal.aborted}, doneSentByStop=${doneSentByStop.has(mid)}, doneSentByStopSize=${doneSentByStop.size}`);
          await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              responsePrefix: messagesConfig.responsePrefix,

              deliver: async (
                payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] },
                _info?: { kind?: string },
              ) => {
                logger.info?.(`${logTag} deliver 回调被触发, aborted=${currentAbort.signal.aborted}, doneSentByStop=${doneSentByStop.has(mid)}`);
                // 如果已被 abort 或 chat.stop 已发出 done，不再发送后续消息
                if (currentAbort.signal.aborted || doneSentByStop.has(mid)) {
                  logger.info?.(`${logTag} deliver 被跳过（已 abort 或 chat.stop 已处理）`);
                  return;
                }

                deliverCount++;
                const now = Date.now();
                const interval = now - lastDeliverTime;
                lastDeliverTime = now;

                logger.info?.(`${logTag} deliver #${deliverCount}, 距上次=${interval}ms`);

                const text = payload.text ?? "";

                logger.debug?.(`${logTag} deliver payload: ${JSON.stringify(payload)}`);

                // 发送信息
                const result = await sendMyWsMessage({
                  accountId: account.accountId,
                  to: address,
                  text: text,
                  reply_id: mid,
                });
                logger.info?.(`${logTag} 消息发送完成, result=${JSON.stringify(result)}`);
              },
              onError: (err: unknown) => {
                logger.error(`${logTag} AI dispatch 错误: ${String(err)}`);
              },
            },
            replyOptions: {},
          });
          const totalTime = Date.now() - dispatchStartTime;
          if (currentAbort.signal.aborted) {
            logger.info?.(`${logTag} AI 回复被中断, 共 ${deliverCount} 次 deliver, 总耗时=${totalTime}ms`);
          } else {
            logger.info?.(`${logTag} AI 回复全部发送完毕, 共 ${deliverCount} 次 deliver, 总耗时=${totalTime}ms`);
          }
        } catch (err) {
          if (currentAbort.signal.aborted) {
            logger.info?.(`${logTag} AI 调用被中止（前端发送了 chat.stop）`);
          } else {
            logger.error(`${logTag} AI 调用异常: ${String(err)}`);
          }
        }
        // 发送完成状态（如果 chat.stop 已提前发过 done，跳过重复发送）
        if (!doneSentByStop.has(mid)) {
          await sendDone({
            accountId: account.accountId,
            to: address,
            text: currentAbort.signal.aborted ? "已停止" : "结束",
            reply_id: mid,
          })
        } else {
          logger.info?.(`${logTag} done 已由 chat.stop 提前发送，跳过`);
        }
      } catch (err) {
        logger.error(`[${account.accountId}] 处理入站消息失败: ${String(err)}`);
        statusSink({ lastError: String(err) });
      } finally {
        // 无论成功失败，清理当前消息的 AbortController 和 doneSentByStop 标记
        messageAbortControllers.delete(mid);
        doneSentByStop.delete(mid);
      }
      }, { sid, mid }); // messageQueue.enqueue end
    });

    ws.on("error", (err) => {
      logger.error(`[${account.accountId}] WebSocket 错误: ${err.message}`);
      statusSink({ lastError: err.message });
    });

    ws.on("close", (code, reason) => {
      clearHeartbeat(); // 连接关闭时停止心跳
      activeConnections.delete(account.accountId);
      const reasonStr = String(reason || "");
      logger.info?.(
        `[${account.accountId}] WebSocket 连接已关闭 (code=${code}, reason=${reasonStr})`,
      );
      
      // 连接关闭时，保持 running: true，但设置 connected: false
      statusSink({ connected: false });
      
      // 清理当前 WebSocket 引用（如果这是当前连接的 close 事件）
      const closedWs = ws;
      if (closedWs) {
        ws = null;
      }
      
      // 如果未停止且未中止，安排重连
      if (!stopped && !abortSignal.aborted) {
        logger.info?.(`[${account.accountId}] 将在 3 秒后尝试重连...`);
        // 清除可能存在的旧重连定时器
        clearReconnectTimer();
        reconnectTimer = setTimeout(() => {
          if (!stopped && !abortSignal.aborted) {
            logger.info?.(`[${account.accountId}] 开始重连...`);
            connect();
          }
        }, 3000);
      } else {
        logger.info?.(`[${account.accountId}] 不重连：已停止或已中止`);
      }
    });
  }

  connect();

  // 返回一个 Promise，这个 Promise 会一直 pending，直到 abortSignal 触发
  // 这样 Gateway 就知道任务还在运行，不会触发自动重启
  // 参考 zalouser 的实现：https://github.com/openclaw/openclaw/blob/main/extensions/zalouser/src/monitor.ts#L659
  const stop = () => {
    stopped = true;
    clearHeartbeat();
    clearReconnectTimer();
    activeConnections.delete(account.accountId);
    ws?.close();
  };

  abortSignal.addEventListener(
    "abort",
    () => {
      stop();
    },
    { once: true },
  );

  // Promise 会一直 pending，直到 abortSignal 触发
  await new Promise<void>((resolve) => {
    abortSignal.addEventListener(
      "abort",
      () => {
        stop();
        resolve();
      },
      { once: true },
    );
  });


   async function downloadImage(url, dest) {
    // 确保目录存在
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const writer = fs.createWriteStream(dest);

    try {
      const response = await axios({
        method: 'get',
        url: url,
        responseType: 'stream', // 重要：设置为 stream
      });

      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', (err) => {
          fs.unlink(dest, () => {}); // 清理文件
          reject(err);
        });
      });
    } catch (error) {
      fs.unlink(dest, () => {}); // 清理文件
      throw error;
    }
  }

  return { stop };
}
