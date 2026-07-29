/**
 * 米哈游账号密码加密。
 *
 * 移植自 cloudgame_checkin main.cpp::CryptoService 与 custom_b64。
 * 账号、密码用同一个 RSA-1024 公钥（X.509 SPKI，PKCS1Padding）加密，
 * 再把密文 hex 经「每 3 个 hex 字符编码为 2 个 base64 字符」的非标准
 * base64 变种编码，得到提交给登录接口的密文。
 */
import crypto from "node:crypto";

const PUB_B64 =
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDDvekdPMHN3AYhm/vktJT+YJr7" +
  "cI5DcsNKqdsx5DZX0gDuWFuIjzdwButrIYPNmRJ1G8ybDIF7oDW2eEpm5sMbL9zs" +
  "9ExXCdvqrn51qELbqj0XxtMTIpaCHFSI50PfPpTFV9Xt/hmyVwokoOXFlAEgCn+Q" +
  "CgGs52bFoYMtyi+xEQIDAQAB";

const B64_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_PAD = "=";

/**
 * 非标准 base64：输入为 hex 字符串，每 3 个 hex 字符（12 bit）编码为
 * 2 个标准 base64 字符；末尾不足 3 个时按高位补零方式补齐，再补 = 对齐。
 */
export function customBase64FromHex(hex: string): string {
  let r = "";
  let i = 0;
  while (i + 3 <= hex.length) {
    const n = parseInt(hex.slice(i, i + 3), 16);
    r += B64_CHARSET[n >> 6]!;
    r += B64_CHARSET[n & 63]!;
    i += 3;
  }
  if (i + 1 === hex.length) {
    const n = parseInt(hex.slice(i, i + 1), 16);
    r += B64_CHARSET[n << 2]!;
  } else if (i + 2 === hex.length) {
    const n = parseInt(hex.slice(i, i + 2), 16);
    r += B64_CHARSET[n >> 2]!;
    r += B64_CHARSET[(n & 3) << 4]!;
  }
  while (r.length % 4 !== 0) r += B64_PAD;
  return r;
}

/** 加密账号或密码，返回提交给 loginByPassword 的密文。 */
export function encryptAccountOrPassword(plaintext: string): string {
  const key = crypto.createPublicKey({
    key: Buffer.from(PUB_B64, "base64"),
    format: "der",
    type: "spki",
  });
  const encrypted = crypto.publicEncrypt(
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(plaintext, "utf8"),
  );
  return customBase64FromHex(encrypted.toString("hex"));
}

const APP_KEY = "d0d3a7342df2026a70f650b907800111";

/** 生成云游戏 combo_token 请求头（HMAC-SHA256 签名）。 */
export function buildComboToken(openId: string, comboTokenRaw: string): string {
  const appId = "4";
  const channelId = "1";
  const query = `app_id=${appId}&channel_id=${channelId}&combo_token=${comboTokenRaw}&open_id=${openId}`;
  const sig = crypto.createHmac("sha256", APP_KEY).update(query).digest("hex");
  return `ai=${appId};ci=${channelId};oi=${openId};ct=${comboTokenRaw};si=${sig};bi=hk4e_cn`;
}

/** 生成随机 hex（用于设备指纹 seed_id 等）。 */
export function randomHex(len: number): string {
  return crypto
    .randomBytes(len)
    .toString("hex")
    .slice(0, len * 2);
}
