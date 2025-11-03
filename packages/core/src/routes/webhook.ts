/**
 * 简化后的 Webhook 路由
 * - 所有平台使用统一的 WebhookAdapter 接口
 * - 统一的错误处理和性能监控
 * - 代码量减少 80%+
 */

import { Hono } from 'hono';
import { Env } from '../types/index.js';
import { getProxyByRandomKey, updateProxyEventCount } from '../db/proxies.js';
import { createAdapter } from '../utils/adapter-factory.js';
import { PerformanceMonitor, classifyError, withRetry } from '../utils/performance.js';

// @ts-ignore
const webhook = new Hono<Env>();

/**
 * 支持的平台列表
 */
const SUPPORTED_PLATFORMS = [
  'github', 'gitlab', 'qqbot', 'telegram',
  'stripe', 'jenkins', 'jira', 'sentry', 'generic'
] as const;

type Platform = typeof SUPPORTED_PLATFORMS[number];

/**
 * 处理 Webhook 请求 - 统一处理所有平台
 * 路由: /:platform/:randomKey
 */
webhook.post('/:platform/:randomKey', async (c) => {
  const platform = c.req.param('platform') as Platform;
  const randomKey = c.req.param('randomKey');
  
  console.log(`[Webhook] === START === ${platform}/${randomKey}`);
  const startTime = Date.now();

  // 启动性能监控
  const perfMonitor = new PerformanceMonitor(platform, randomKey);

  try {
    // 1. 验证平台
    console.log(`[Webhook] Step 1: Validating platform: ${platform}`);
    if (!SUPPORTED_PLATFORMS.includes(platform as any)) {
      perfMonitor.end('error', 'InvalidPlatform');
      return c.text('Invalid platform', 400);
    }

    // 2. 查找 proxy 配置（带超时保护）
    console.log(`[Webhook] Step 2: Querying DB for randomKey: ${randomKey}`);
    const dbStart = Date.now();
    
    // 添加超时保护：5 秒
    const dbQueryPromise = getProxyByRandomKey(c.env!.DB as D1Database, randomKey);
    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
    
    const proxy = await Promise.race([dbQueryPromise, timeoutPromise]);
    const dbDuration = Date.now() - dbStart;
    
    console.log(`[Webhook] DB query took: ${dbDuration}ms`);
    
    if (proxy === null) {
      console.error(`[Webhook] DB query timeout after ${dbDuration}ms`);
      perfMonitor.end('error', 'DBTimeout');
      return c.text('Database timeout', 500);
    }

    if (!proxy) {
      console.log(`[Webhook] Proxy not found for randomKey: ${randomKey}`);
      perfMonitor.end('error', 'ProxyNotFound');
      return c.text('Proxy not found', 404);
    }

    console.log(`[Webhook] Step 3: Proxy found, checking status`);
    
    if (!proxy.active) {
      perfMonitor.end('error', 'ProxyInactive');
      return c.text('Proxy is inactive', 403);
    }

    if (proxy.platform !== platform) {
      perfMonitor.end('error', 'PlatformMismatch');
      return c.text('Platform mismatch', 400);
    }
    
    console.log(`[Webhook] Step 4: Proxy validation passed`);

    console.log(`[Webhook] Received: ${platform}/${randomKey}`);

    // 3. 创建适配器
    const adapter = createAdapter(proxy);

    if (!adapter) {
      perfMonitor.end('error', 'AdapterCreationFailed');
      return c.text('Failed to create adapter', 500);
    }

    // 4. 处理 Webhook 请求（验证签名）
    // 需要克隆请求，因为 handleWebhook 会读取 body
    const clonedRequest = c.req.raw.clone();
    
    console.log(`[Webhook] Calling adapter.handleWebhook for ${platform}`);
    const response = await adapter.handleWebhook(c.req.raw);
    console.log(`[Webhook] Adapter returned status: ${response.status}`);

    // 5. 如果验证成功，转换并广播事件
    // 注意：QQ Bot 的 OpCode 13（回调验证）不需要广播
    if (response.status === 200) {
      // QQ Bot 特殊处理：只广播 OpCode 0 的事件
      if (platform === 'qqbot') {
        console.log('[Webhook] QQ Bot: reading body to check OpCode');
        const bodyText = await clonedRequest.text();
        const payload = JSON.parse(bodyText);
        
        console.log(`[Webhook] QQ Bot OpCode: ${payload.op}`);
        
        // 只有 OpCode 0（Dispatch）才需要广播
        if (payload.op === 0) {
          console.log('[Webhook] QQ Bot: Broadcasting OpCode 0 event');
          c.executionCtx.waitUntil(
            broadcastEvent(c, adapter, clonedRequest.clone(), proxy.id, randomKey)
          );
        } else {
          console.log(`[Webhook] QQ Bot OpCode ${payload.op}, skip broadcast`);
        }
      } else {
        // 其他平台正常广播
        c.executionCtx.waitUntil(
          broadcastEvent(c, adapter, clonedRequest, proxy.id, randomKey)
        );
      }
    }

    perfMonitor.end('success');
    return response;

  } catch (error) {
    const errorType = classifyError(error);
    perfMonitor.end('error', errorType);

    console.error(`[Webhook] Error: ${platform}/${randomKey}:`, error);

    // 返回友好的错误信息
    if (error instanceof SyntaxError) {
      return c.text('Invalid JSON payload', 400);
    } else if (error instanceof TypeError) {
      return c.text('Invalid request format', 400);
    }

    return c.text('Internal server error', 500);
  }
});

/**
 * 广播事件到 Durable Object（异步）
 */
async function broadcastEvent(
  c: any,
  adapter: any,
  request: Request,
  proxyId: string,
  randomKey: string
): Promise<void> {
  try {
    // 1. 解析 payload
    const payload = await request.json();

    // 2. 转换事件
    const event = adapter.transform(payload, request);

    // 3. 更新事件计数（带重试）
    await withRetry(
      () => updateProxyEventCount(c.env!.DB as D1Database, proxyId),
      { maxRetries: 2, initialDelay: 100 },
      (error, attempt) => {
        console.warn(`[DB] Update failed (attempt ${attempt + 1}):`, error);
        return true; // 继续重试
      }
    );

    // 4. 广播到 Durable Object（带重试）
    await withRetry(
      async () => {
        const doId = (c.env as Record<string, any>).WEBHOOK_CONNECTIONS.idFromName(randomKey);
        const doStub = (c.env as Record<string, any>).WEBHOOK_CONNECTIONS.get(doId);

        const doResponse = await doStub.fetch(new Request(`https://do/broadcast`, {
          method: 'POST',
          body: JSON.stringify(event),
          headers: { 'Content-Type': 'application/json' },
        }));

        if (!doResponse.ok) {
          throw new Error(`DO broadcast failed: ${doResponse.status}`);
        }
      },
      { maxRetries: 2, initialDelay: 100 },
      (error, attempt) => {
        console.warn(`[DO] Broadcast failed (attempt ${attempt + 1}):`, error);
        return true; // 继续重试
      }
    );

    console.log(`[Webhook] Event broadcasted: ${event.type}`);
  } catch (error) {
    // 广播失败不影响 Webhook 响应（已经返回了）
    console.error('[Webhook] Broadcast error:', error);
  }
}

/**
 * WebSocket/SSE 连接路由
 */
webhook.get('/:platform/:randomKey/:connectionType', async (c) => {
  const platform = c.req.param('platform') as Platform;
  const randomKey = c.req.param('randomKey');
  const connectionType = c.req.param('connectionType');

  try {
    // 验证参数
    if (!SUPPORTED_PLATFORMS.includes(platform as any)) {
      return c.text('Invalid platform', 400);
    }

    if (!['ws', 'sse'].includes(connectionType)) {
      return c.text('Invalid connection type', 400);
    }

    // 验证 proxy
    const proxy = await getProxyByRandomKey(c.env!.DB as D1Database, randomKey);

    if (!proxy || !proxy.active) {
      return c.text('Proxy not found or inactive', 404);
    }

    if (proxy.platform !== platform) {
      return c.text('Platform mismatch', 400);
    }

    // 转发到 Durable Object
    const doId = (c.env as Record<string, any>).WEBHOOK_CONNECTIONS.idFromName(randomKey);
    const doStub = (c.env as Record<string, any>).WEBHOOK_CONNECTIONS.get(doId);

    const newHeaders = new Headers(c.req.raw.headers);
    newHeaders.set('X-Proxy-Access-Token', proxy.access_token || '');

    const newRequest = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: newHeaders,
      body: c.req.raw.body,
    });

    const response = await doStub.fetch(newRequest);

    // 对于 WebSocket 连接，需要传递 webSocket 对象
    if (connectionType === 'ws') {
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
        // @ts-ignore - webSocket 是 WebSocket 响应需要的
        webSocket: (response as any).webSocket,
      });
    }

    // 对于 SSE 连接，直接返回流式响应
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  } catch (error) {
    console.error('[Connection] Error:', error);
    return c.text('Internal server error', 500);
  }
});

export default webhook;

