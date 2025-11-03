/**
 * Ed25519 签名验证工具
 * 用于 QQ Bot Webhook 签名验证
 * 
 * 参考：
 * - https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html#webhook%E6%96%B9%E5%BC%8F
 * - https://github.com/zhinjs/qq-official-bot
 * - @noble/curves/ed25519 (纯 JS 实现，Cloudflare Workers 兼容)
 * 
 * QQ Bot 签名机制：
 * 1. OpCode 13（回调验证）：签名 event_ts + plain_token 并返回
 * 2. OpCode 0（事件推送）：验证 QQ Bot 发来的签名（timestamp + body）
 * 3. 签名算法：Ed25519，使用 App Secret 派生密钥对
 * 4. 使用 tweetnacl 库（和成功的 KarinJS 实现完全一致）
 * 
 * 密钥派生规则：
 * - 将 secret 重复填充到至少 32 字节
 * - 截取前 32 字节作为种子
 * - 使用种子通过 TweetNaCl 兼容的方式生成 Ed25519 密钥对
 */

// 注意：不在顶层导入 tweetnacl，而是在使用时动态导入
// 这样可以确保在 Cloudflare Workers 环境中正确加载

/**
 * 将 hex 字符串转换为 Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  hex = hex.replace(/^0x/, '').trim();
  
  if (hex.length % 2 !== 0) {
    throw new Error('Hex string must have an even number of characters');
  }
  
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * 将 Uint8Array 转换为 hex 字符串
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Ed25519 签名和验证类
 * 使用 tweetnacl（和 Yunzai-QQBot-Plugin 完全一致）
 */
export class Ed25519 {
  private secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  /**
   * 签名消息（用于 OpCode 13 回调验证）
   * 完全按照 Yunzai 的实现
   * 
   * @param message - 待签名的消息字符串
   * @returns 签名（hex 编码）
   */
  async sign(message: string): Promise<string> {
    try {
      // 动态导入 tweetnacl（和 Yunzai 一样）
      // @ts-ignore
      const { sign } = (await import('tweetnacl')).default;
      
      // 处理 secret（和 Yunzai 一样）
      let secret = this.secret;
      while (secret.length < 32) {
        secret = secret.repeat(2).slice(0, 32);
      }
      
      // 创建 Uint8Array（和 Yunzai 的 Buffer.from 等价）
      const seedBytes = new TextEncoder().encode(secret);
      
      // 生成密钥对（和 Yunzai 一样）
      const keyPair = sign.keyPair.fromSeed(seedBytes);
      
      // 签名（和 Yunzai 一样）
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = sign.detached(messageBytes, keyPair.secretKey);
      
      // 转换为 hex（和 Yunzai 的 Buffer.toString('hex') 等价）
      return bytesToHex(signatureBytes);
    } catch (error) {
      console.error('[Ed25519] Sign error:', error);
      throw error;
    }
  }

  /**
   * 验证签名（用于 OpCode 0 事件推送）
   * 
   * @param signature - 签名（hex 编码）
   * @param message - 原始消息字符串
   * @returns 签名是否有效
   */
  async verify(signature: string, message: string): Promise<boolean> {
    try {
      // 动态导入 tweetnacl
      // @ts-ignore
      const { sign } = (await import('tweetnacl')).default;
      
      // 处理 secret
      let secret = this.secret;
      while (secret.length < 32) {
        secret = secret.repeat(2).slice(0, 32);
      }
      
      const seedBytes = new TextEncoder().encode(secret);
      const keyPair = sign.keyPair.fromSeed(seedBytes);
      
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = hexToBytes(signature);
      
      // Ed25519 签名应该是 64 字节
      if (signatureBytes.length !== 64) {
        console.error('[Ed25519] Invalid signature length:', signatureBytes.length, 'expected 64');
        return false;
      }
      
      // 使用 tweetnacl 验证签名
      return sign.detached.verify(messageBytes, signatureBytes, keyPair.publicKey);
    } catch (error) {
      console.error('[Ed25519] Verify error:', error);
      return false;
    }
  }
}

/**
 * 验证 QQ Bot Webhook 签名（便捷函数）
 * 
 * @param body - 请求体（字符串）
 * @param timestamp - 时间戳（X-Signature-Timestamp header）
 * @param signature - 签名（X-Signature-Ed25519 header）
 * @param secret - App Secret
 * @returns 签名是否有效
 */
export async function verifyQQBotSignature(
  body: string,
  timestamp: string,
  signature: string,
  secret: string
): Promise<boolean> {
  // QQ Bot 签名验证算法：timestamp + body
  const message = timestamp + body;
  const ed25519Instance = new Ed25519(secret);
  return ed25519Instance.verify(signature, message);
}

/**
 * 签名 QQ Bot 回调验证（便捷函数，用于 OpCode 13）
 * 
 * @param eventTs - 事件时间戳
 * @param plainToken - 明文 token
 * @param secret - App Secret
 * @returns 签名（hex 编码）
 */
export async function signQQBotCallback(
  eventTs: string,
  plainToken: string,
  secret: string
): Promise<string> {
  // QQ Bot 回调验证算法：event_ts + plain_token（和 KarinJS 一致）
  const message = eventTs + plainToken;
  const ed25519Instance = new Ed25519(secret);
  return ed25519Instance.sign(message);
}
