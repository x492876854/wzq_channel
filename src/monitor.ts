import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { buildAgentMediaPayload } from "openclaw/plugin-sdk";
import WebSocket from "ws";
import type { ResolvedMyWsAccount } from "./accounts.js";
import { getMyWsRuntime } from "./runtime.js";
import {sendMyWsMessage, sendProcessing} from "./send";
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let isConn = false

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
  runtime: RuntimeEnv;
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
 * 启动 WebSocket 长连接监听，入站消息通过 runtime.channel.inbound.dispatch 分发给 agent。
 * 返回 { stop } 供 gateway 在 abort 时调用。
 */
export async function startMyWsMonitor(opts: MonitorOptions): Promise<{ stop: () => void }> {

  if (isConn) {
    console.log("只创建一个链接")
    return
  }
  console.log("正在启动 WebSocket 连接")

  const { account, runtime, abortSignal, statusSink, cfg } = opts;
  const core = getMyWsRuntime();
  const logger = core.logging.getChildLogger({
    channel: "wzq-channel",
    accountId: account.accountId,
  });

  let stopped = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // ── 心跳保活 ──────────────────────────────────────────────────────────────
  // 每隔 HEARTBEAT_INTERVAL 毫秒发送一次 ping；
  // 若在 HEARTBEAT_TIMEOUT 毫秒内未收到 pong，则主动关闭连接触发重连。
  const HEARTBEAT_INTERVAL = 30_000; // 30 秒发一次 ping
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
      console.log('socket send pin')
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

  /**
   * 读取 openclaw gateway 配置（端口、token）
   */
  function readGatewayConfig(): { port: number; token: string } {
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
  function callGateway(method: string, params: Record<string, any> = {}): Promise<any> {
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
      const reqUrl = account.wsUrl + "?" + account.token
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
      console.log("socket get pong")
      if (pongTimeoutTimer !== null) {
        clearTimeout(pongTimeoutTimer);
        pongTimeoutTimer = null;
      }
      waitingForPong = false;
    });

    ws.on("message", async (data) => {
      try {
        // 记录入站活动
        core.channel.activity.record({
          channel: "wzq-channel",
          accountId: account.accountId,
          direction: "inbound",
          at: Date.now(),
        });
        statusSink({ lastInboundAt: Date.now() });

        // 解析服务器推送的消息
        // 期望格式：{session_id,content_type,content}
        // 可根据实际服务器协议调整此处的字段映射
        const msg = JSON.parse(String(data)) as {
          session_id?: string;
          content_type?: string;
          content?: string;
        };

        // ── 处理 control 类型消息：通用 gateway RPC 透传 ─────────────────
        // content 为序列化的 JSON: { method: "cron.list", params: { ... } }
        // method 直接对应 gateway RPC 方法名，params 直接透传给 gateway
        if (msg.content_type === "control") {
          let ctrl: { method?: string; params?: Record<string, any> } = {};
          try {
            ctrl = msg.content ? JSON.parse(msg.content) : {};
          } catch {
            console.warn("[control] content 解析失败，忽略");
            return;
          }
          const { method, params = {} } = ctrl;
          if (!method) {
            console.warn("[control] 缺少 method 字段，忽略");
            return;
          }
          console.log(`[control] 收到 gateway 调用: ${method}`);

          try {
            const payload = await callGateway(method, params);
            console.log(`[control] ${method} 调用成功`);
            ws?.send(JSON.stringify({
              content_type: "control",
              content: JSON.stringify({ method, data: payload }),
              session_id: msg.session_id,
            }));
          } catch (err) {
            console.error(`[control] ${method} 调用失败: ${err}`);
            ws?.send(JSON.stringify({
              content_type: "control",
              content: JSON.stringify({ method, error: String(err) }),
              session_id: msg.session_id,
            }));
          }
          return;
        }

        if (!msg.session_id) {
          logger.warn?.(`[${account.accountId}] 收到格式不符的消息，已忽略: ${String(data)}`);
          return;
        }

        if (!msg.content) {
          logger.warn?.(`[${account.accountId}] 收到格式不符的消息，已忽略: ${String(data)}`);
          return;
        }

        console.log("send message" + msg.content);
        // 处理图片媒体（参考飞书插件 bot.ts 的标准做法）
        // 使用 core.channel.media.saveMediaBuffer 保存到 openclaw 允许的目录
        const mediaList: Array<{ path: string; contentType: string; placeholder: string }> = [];
        if (msg.content.indexOf("image") !== -1) {
          const tmpMsgList = JSON.parse(msg.content)
          console.log(tmpMsgList);
          let newTmpMsgList: any[] = [];
          for (const item of tmpMsgList) {
            if (item.type == 'image') {
              console.log("image")
              const baseUrl = account.fileUrl + "?token=" + account.token + "&image_id="
              const imageId = item.image_id;
              const imageUrl = baseUrl + imageId;
              console.log("请求路径是" + imageUrl)
              try {
                // 下载图片到内存（Buffer）
                const response = await axios({
                  method: 'get',
                  url: imageUrl,
                  responseType: 'arraybuffer',
                });
                const buffer = Buffer.from(response.data);
                const contentType = response.headers['content-type'] || 'image/jpeg';
                console.log(`图片下载成功, size=${buffer.length}, contentType=${contentType}`);

                // 使用 openclaw 核心 API 保存到允许的目录
                const saved = await core.channel.media.saveMediaBuffer(
                  buffer,
                  contentType,
                  "inbound",
                  30 * 1024 * 1024, // 30MB max
                );
                console.log(`图片已保存到 openclaw 媒体目录: ${saved.path}`);

                mediaList.push({
                  path: saved.path,
                  contentType: saved.contentType,
                  placeholder: "<media:image>",
                });
              } catch (err) {
                console.error(`下载/保存图片失败: ${err}`);
              }
            } else {
              newTmpMsgList.push(item);
            }
          }
          console.log("替换完以后得数据")
          console.log(newTmpMsgList);
          console.log("mediaList:", mediaList);
          msg.content = JSON.stringify(newTmpMsgList);
        }

        // 使用 buildAgentMediaPayload 构建标准媒体字段
        const mediaPayload = buildAgentMediaPayload(mediaList);

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

        console.log('结构完成')

        try {
          const messagesConfig = core.channel.reply.resolveEffectiveMessagesConfig(
            cfg,
            route.agentId,
          );
          console.log("执行ai调用")
          // 发送思考中状态
          await sendProcessing({
            accountId: account.accountId,
            to: address,
            text: "思考中",
          })
          await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              responsePrefix: messagesConfig.responsePrefix,

              deliver: async (
                payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] },
                _info?: { kind?: string },
              ) => {
                console.log("ai调用回复")

                const text = payload.text ?? "";

                console.log(JSON.stringify(payload))

                // 发送信息
                const result = await sendMyWsMessage({
                  accountId: account.accountId,
                  to: address,
                  text: text,
                });
                console.log("发送信息返回结果是")
                console.log(result)
              },
              onError: (err: unknown) => {
                console.log("AI dispatch onerror")
                console.log(err)
              },
            },
            replyOptions: {},
          });
          console.log("整段代码执行完毕")
        } catch (err) {
          console.log('catech exception')
          console.log(err)
        }
      } catch (err) {
        logger.error(`[${account.accountId}] 处理入站消息失败: ${String(err)}`);
        statusSink({ lastError: String(err) });
      }
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
