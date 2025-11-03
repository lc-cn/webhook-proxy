/**
 * QQ Bot Webhook 适配器（Cloudflare Workers 版本）
 * 
 * 文档：https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
 * 
 * QQ Bot Webhook 流程：
 * 1. OpCode 13：回调地址验证 - 需要签名 plain_token + event_ts 并返回
 * 2. OpCode 0：事件推送 - 需要验证签名，然后返回 OpCode 12 (ACK)
 * 
 * 签名验证：
 * - Headers: X-Signature-Timestamp, X-Signature-Ed25519
 * - 算法：Ed25519
 * - 消息：timestamp + body
 * - 密钥：App Secret（不是公钥！）
 */

import { WebhookEventData } from '../types/index.js';
import { Ed25519 } from '../utils/ed25519.js';

export interface QQBotPayload {
  id?: string;         // 事件id（OpCode 0 才有）
  op: number;          // opcode
  d: any;              // 事件内容
  s?: number;          // 序列号（OpCode 0 才有）
  t?: string;          // 事件类型（OpCode 0 才有）
}

export interface QQBotConfig {
  appId: string;       // 机器人 App ID
  secret: string;      // 机器人 App Secret（用于签名和验证）
  verifySignature: boolean;
}

/**
 * QQ Bot 适配器
 */
export class QQBotAdapter {
  private ed25519: Ed25519 | null = null;

  constructor(private config: QQBotConfig) {
    // 如果配置了 secret，初始化 Ed25519
    if (config.secret) {
      this.ed25519 = new Ed25519(config.secret);
    }
  }

  /**
   * 验证签名
   * 
   * QQ Bot 签名验证说明：
   * - Headers 中包含：
   *   - X-Signature-Timestamp: 时间戳
   *   - X-Signature-Ed25519: 签名（hex 格式）
   * - 签名算法：Ed25519
   * - 待签名消息：timestamp + body
   * - 密钥：App Secret
   */
  async verifySignature(
    body: string,
    timestamp: string,
    signature: string
  ): Promise<boolean> {
    if (!this.config.verifySignature) {
      console.log('[QQBot] Signature verification disabled');
      return true;
    }

    if (!this.ed25519) {
      console.error('[QQBot] App Secret not configured');
      return false;
    }

    console.log('[QQBot] Verifying signature...');
    console.log('[QQBot] Timestamp:', timestamp);
    console.log('[QQBot] Signature:', signature.substring(0, 16) + '...');

    try {
      const message = timestamp + body;
      const isValid = await this.ed25519.verify(signature, message);

      if (!isValid) {
        console.error('[QQBot] Signature verification failed');
        console.error('[QQBot] Body preview:', body.substring(0, 100) + '...');
      } else {
        console.log('[QQBot] Signature verification passed');
      }

      return isValid;
    } catch (error) {
      console.error('[QQBot] Signature verification error:', error);
      return false;
    }
  }

  /**
   * 将 QQ Bot Webhook 转换为标准事件格式
   */
  transform(payload: QQBotPayload): WebhookEventData {
    const { id, op, d, s, t } = payload;

    return {
      id: id || `qqbot_${Date.now()}`,
      platform: 'qqbot',
      type: t || `op_${op}`,
      timestamp: Date.now(),
      headers: {
        'x-qqbot-op': op.toString(),
        'x-qqbot-seq': s?.toString() || '',
        'x-qqbot-event-type': t || '',
      },
      payload: d,
      data: {
        opcode: op,
        event_type: t || '',
        sequence: s || 0,
        event_id: id || '',
        event_data: d,
      },
    };
  }

  /**
   * 处理 Webhook 请求
   */
  async handleWebhook(request: Request): Promise<Response> {
    try {
      // 读取请求体
      const body = await request.text();
      
      // 获取签名相关 headers
      const timestamp = request.headers.get('X-Signature-Timestamp') || '';
      const signature = request.headers.get('X-Signature-Ed25519') || '';
      const userAgent = request.headers.get('User-Agent') || '';
      const appId = request.headers.get('X-Bot-Appid') || '';

      // 日志记录
      console.log('[QQBot] Incoming request:');
      console.log('[QQBot]   User-Agent:', userAgent);
      console.log('[QQBot]   X-Bot-Appid:', appId);
      console.log('[QQBot]   Body preview:', body.substring(0, 100) + '...');

      // 验证 User-Agent（可选，但推荐）
      if (userAgent && userAgent !== 'QQBot-Callback') {
        console.warn('[QQBot] Unexpected User-Agent:', userAgent);
      }

      // 解析 payload
      const payload: QQBotPayload = JSON.parse(body);

      console.log('[QQBot] OpCode:', payload.op);
      console.log('[QQBot] Event type:', payload.t);

      // OpCode 13 (回调验证) 不需要验证签名，直接处理
      if (payload.op === 13) {
        console.log('[QQBot] OpCode 13: Callback verification, skip signature check');
        return await this.handleVerification(payload);
      }

      // 其他 OpCode 需要验证签名
      if (this.config.verifySignature && timestamp && signature) {
        const isValid = await this.verifySignature(body, timestamp, signature);
        if (!isValid) {
          return new Response('Invalid signature', { status: 401 });
        }
      }

      // 处理不同的 opcode
      switch (payload.op) {
        
        case 0: // Dispatch - 正常事件推送
          return this.handleDispatch(payload);
        
        default:
          console.warn('[QQBot] Unknown opcode:', payload.op);
          return this.createAckResponse();
      }
    } catch (error) {
      console.error('[QQBot] Handle webhook error:', error);
      return new Response('Internal server error', { status: 500 });
    }
  }

  /**
   * 处理回调地址验证（OpCode 13）
   * 
   * QQ Bot 会发送：
   * {
   *   "op": 13,
   *   "d": {
   *     "plain_token": "xxx",
   *     "event_ts": "1234567890"
   *   }
   * }
   * 
   * 需要返回：
   * {
   *   "plain_token": "xxx",
   *   "signature": sign(plain_token + event_ts)
   * }
   * 
   * 注意：签名顺序是 plain_token + event_ts
   */
  private async handleVerification(payload: QQBotPayload): Promise<Response> {
    const { plain_token, event_ts } = payload.d;

    if (!plain_token || !event_ts) {
      console.error('[QQBot] Missing plain_token or event_ts');
      return new Response('Bad request', { status: 400 });
    }

    if (!this.ed25519) {
      console.error('[QQBot] App Secret not configured, cannot sign');
      return new Response('Server configuration error', { status: 500 });
    }

    try {
      // 确保转换为字符串（QQ Bot 可能发送数字类型的 event_ts）
      const plainTokenStr = String(plain_token);
      const eventTsStr = String(event_ts);
      
      // 签名：event_ts + plain_token
      const message = eventTsStr + plainTokenStr;
      const signature = await this.ed25519.sign(message);

      return new Response(
        JSON.stringify({
          plain_token,
          signature,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } catch (error) {
      console.error('[QQBot] Verification error:', error);
      return new Response('Internal server error', { status: 500 });
    }
  }

  /**
   * 处理事件分发（OpCode 0）
   * 
   * 需要返回 HTTP Callback ACK (OpCode 12)
   */
  private handleDispatch(payload: QQBotPayload): Response {
    console.log('[QQBot] 🎉 Dispatch event received!');
    console.log('[QQBot]   Event Type:', payload.t);
    console.log('[QQBot]   Event ID:', payload.id);
    console.log('[QQBot]   Sequence:', payload.s);
    console.log('[QQBot]   Payload:', JSON.stringify(payload.d).substring(0, 200));
    console.log('[QQBot] Sending ACK (OpCode 12)');
    return this.createAckResponse();
  }

  /**
   * 创建 ACK 响应（OpCode 12）
   */
  private createAckResponse(): Response {
    return new Response(
      JSON.stringify({
        op: 12, // HTTP Callback ACK
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * 创建 QQ Bot 适配器实例
 */
export function createQQBotAdapter(config: QQBotConfig): QQBotAdapter {
  return new QQBotAdapter(config);
}
