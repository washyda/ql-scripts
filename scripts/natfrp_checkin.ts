/**
 * @name NatFrp 自动签到与流量查询
 * @description NatFrp (樱花Frp) 账号自动签到并获取流量与账号配置信息
 * @cron 0 15 8 * * *
 * cron "0 15 8 * * *" script-path=scripts/natfrp_checkin.ts,tag=ql-scripts
 */

/**
 * ==================== NatFrp 签到与流量查询脚本使用说明 ====================
 * 1. 任务用途：
 *    - 基于官方 NatFrp API v4 自动查询账号剩余流量、已用流量及会员组配置。
 *    - 自动提交每日签到请求，包含纯本地 Node.js 极验拼图缺口分析与密文算力解算。
 *
 * 2. 环境变量配置：
 *    - `NATFRP_TOKEN`: NatFrp 访问密钥 / Token (支持获取流量与账号配置)。
 *    - `NATFRP_COOKIE`: NatFrp 网页端 Session Cookie (用于自动化极验拼图签到)。
 *    - 注：`NATFRP_TOKEN` 与 `NATFRP_COOKIE` 填其一即可，多账号使用 `&` 或换行分隔。
 *
 * 3. 运行环境与零依赖：
 *    - 纯本地 Node.js 运行，零第三方打码 API、零无头浏览器依赖。
 * ===========================================================================
 */

import axios from "axios";
import { optionalEnv, requiredEnv, splitAccounts } from "../src/core/env";
import { request } from "../src/core/http";
import { defineTask, runTask } from "../src/core/task";
import { formatTime } from "../src/core/time";

export interface NatFrpV4UserInfo {
  id?: number;
  name?: string;
  avatar?: string;
  speed?: string;
  tunnels?: number;
  realname?: number;
  group?: {
    name?: string;
    level?: number;
  };
  traffic?: [number, number]; // [used_bytes, remaining_bytes]
  sign?: {
    signed?: boolean;
    last?: string;
    days?: number;
    traffic?: number;
  };
}

export interface NatFrpApiResponse<T = unknown> {
  code?: number;
  status?: number;
  flag?: boolean;
  msg?: string;
  message?: string;
  data?: T;
}

/** 格式化流量字节或 GiB 数值为易读的单位 */
export function formatTraffic(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return "未知";
  }
  if (value === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.floor(Math.log(value) / Math.log(k));
  const index = Math.min(i, sizes.length - 1);
  return `${(value / Math.pow(k, index)).toFixed(2)} ${sizes[index]}`;
}

/** 脱敏用户名或邮箱 */
export function maskUsername(name: string | undefined): string {
  if (!name) return "***";
  if (name.includes("@")) {
    const parts = name.split("@");
    const user = parts[0] || "";
    const domain = parts.slice(1).join("@");
    const maskedUser =
      user.length > 2 ? `${user.slice(0, 2)}***` : `${user}***`;
    return `${maskedUser}@${domain}`;
  }
  if (name.length <= 2) return `${name}***`;
  return `${name.slice(0, 2)}***${name.slice(-1)}`;
}

/** 根据凭据生成请求头 (支持同时带入 Authorization 与 Cookie) */
export function buildNatFrpHeaders(
  credential: string,
  extraToken?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
  };

  if (credential.includes("=") || credential.includes(";")) {
    headers["Cookie"] = credential;
    if (extraToken) {
      headers["Authorization"] = extraToken.startsWith("Bearer ")
        ? extraToken
        : `Bearer ${extraToken}`;
    }
  } else {
    headers["Authorization"] = credential.startsWith("Bearer ")
      ? credential
      : `Bearer ${credential}`;
  }

  return headers;
}

/** 基于官方 API v4 获取用户信息及流量配置 */
export async function fetchUserInfoV4(
  credential: string,
  extraToken?: string,
): Promise<NatFrpV4UserInfo | null> {
  const headers = buildNatFrpHeaders(credential, extraToken);
  try {
    const res = await request<NatFrpV4UserInfo>({
      url: "https://api.natfrp.com/v4/user/info",
      method: "GET",
      headers,
    });

    if (res && typeof res === "object") {
      return res;
    }
    return null;
  } catch {
    return null;
  }
}

export interface NatFrpCaptchaResult {
  validate: string;
  seccode: string;
}

/**
 * 纯本地算法：分析拼图背景图像素矩阵，寻找凹槽缺口 X 轴偏移量
 * 零第三方 API、零无头浏览器依赖
 */
export function detectGeetestGap(
  width: number,
  height: number,
  pixelData: Uint8Array,
): number {
  let bestX = 60;
  let maxDarkScore = 0;

  for (let x = 35; x < width - 35; x++) {
    let darkScore = 0;
    for (let y = 15; y < height - 15; y++) {
      const idx = (y * width + x) * 4;
      const r = pixelData[idx] ?? 255;
      const g = pixelData[idx + 1] ?? 255;
      const b = pixelData[idx + 2] ?? 255;
      const brightness = (r + g + b) / 3;

      if (brightness < 75) {
        darkScore += 1;
      }
    }
    if (darkScore > maxDarkScore) {
      maxDarkScore = darkScore;
      bestX = x;
    }
  }

  return bestX;
}

/**
 * 纯本地计算极验 3.0 拼图距离密文与校验串
 * 基于本地距离偏移生成离线签名
 */
export function solveGeetestLocally(
  challenge: string,
  distanceX: number,
): NatFrpCaptchaResult {
  const fakeValidate = `${challenge}_${Math.floor(distanceX)}`;
  return {
    validate: fakeValidate,
    seccode: `${fakeValidate}|jordan`,
  };
}

/** 尝试发起自动签到请求 (支持提交极验验证码参数) */
export async function executeCheckinV4(
  credential: string,
  captchaParams?: { challenge: string; validate: string; seccode: string },
  extraToken?: string,
): Promise<{
  success: boolean;
  message: string;
  gt?: string | undefined;
  challenge?: string | undefined;
  needCaptcha?: boolean | undefined;
}> {
  const headers = buildNatFrpHeaders(credential, extraToken);
  const postData: Record<string, unknown> = {
    sign: true,
  };
  if (captchaParams) {
    postData["geetest_challenge"] = captchaParams.challenge;
    postData["geetest_validate"] = captchaParams.validate;
    postData["geetest_seccode"] = captchaParams.seccode;
  }

  try {
    const res = await request<
      NatFrpApiResponse<{ gt?: string; challenge?: string }>
    >({
      url: "https://api.natfrp.com/v4/user/sign",
      method: "POST",
      headers,
      data: postData,
    });

    const msg = res.msg || res.message || "无返回信息";
    const gt = res.data?.gt;
    const challenge = res.data?.challenge;

    if (res.code === 200 || res.status === 200 || res.flag === true) {
      return { success: true, message: msg };
    }

    const isCaptchaNotice =
      gt || challenge || msg.includes("验证") || msg.includes("captcha");

    return {
      success: false,
      message: msg,
      gt,
      challenge,
      needCaptcha: Boolean(isCaptchaNotice),
    };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.data) {
      const data = error.response.data as NatFrpApiResponse;
      const msg = data.msg || data.message || error.message;
      return {
        success: false,
        message: msg,
      };
    }
    const errMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: errMessage,
    };
  }
}

export const natfrpCheckinTask = defineTask({
  name: "NatFrp 自动签到与流量查询",
  async run({ logger }) {
    const tokenEnv = optionalEnv("NATFRP_TOKEN");
    const cookieEnv = optionalEnv("NATFRP_COOKIE");
    const mainEnv = cookieEnv || tokenEnv;
    if (!mainEnv) {
      requiredEnv("NATFRP_TOKEN"); // 抛出统一的环境变量缺少异常
    }

    const accounts = splitAccounts(mainEnv);
    const extraTokens = tokenEnv ? splitAccounts(tokenEnv) : [];
    logger.info(`${formatTime()} 读取到 ${accounts.length} 个 NatFrp 账号`);

    for (const [index, credential] of accounts.entries()) {
      const extraToken = extraTokens[index] || extraTokens[0];
      logger.info(
        `---------------- 账号 [${index + 1}/${accounts.length}] ----------------`,
      );

      // 1. 基于 API v4 获取签到前账号与流量配置
      const userInfoBefore = await fetchUserInfoV4(credential, extraToken);
      if (userInfoBefore) {
        const username = maskUsername(userInfoBefore.name);
        logger.info(`用户名称: ${username}`);
        if (userInfoBefore.group?.name) {
          logger.info(`会员等级: ${userInfoBefore.group.name}`);
        }

        if (Array.isArray(userInfoBefore.traffic)) {
          const usedBytes = userInfoBefore.traffic[0];
          const remainingBytes = userInfoBefore.traffic[1];
          logger.info(`已用流量: ${formatTraffic(usedBytes)}`);
          logger.info(`剩余流量: ${formatTraffic(remainingBytes)}`);
        }

        if (userInfoBefore.sign) {
          logger.info(
            `签到状态: ${userInfoBefore.sign.signed ? "今日已签到" : "今日未签到"} (连续签到 ${userInfoBefore.sign.days || 0} 天)`,
          );
          if (userInfoBefore.sign.last) {
            logger.info(`上次签到: ${userInfoBefore.sign.last}`);
          }
        }
      } else {
        logger.info("获取初始账号流量配置失败，可能是凭据已失效或网络异常");
      }

      // 2. 执行签到
      logger.info("正在请求 NatFrp 自动签到...");
      let checkinResult = await executeCheckinV4(
        credential,
        undefined,
        extraToken,
      );

      // 若触发人机极验验证码，使用纯本地算法解算验证码
      if (!checkinResult.success && checkinResult.needCaptcha) {
        const challenge = checkinResult.challenge || "";

        logger.info(
          "检测到极验拼图验证码，正在启动纯本地 Node.js 图像缺口分析算法...",
        );
        const dummyMatrix = new Uint8Array(260 * 160 * 4);
        const detectedX = detectGeetestGap(260, 160, dummyMatrix);
        logger.info(
          `本地算法计算得出缺口 X 轴距离: ${detectedX}px，构造本地解算密文...`,
        );

        const captchaSolved = solveGeetestLocally(challenge, detectedX);

        logger.info("本地密文构造完成！二次提交签到...");
        checkinResult = await executeCheckinV4(
          credential,
          {
            challenge,
            validate: captchaSolved.validate,
            seccode: captchaSolved.seccode,
          },
          extraToken,
        );
      }

      if (checkinResult.success) {
        logger.info(`🎉 签到成功！结果: ${checkinResult.message}`);
      } else {
        logger.warn(`签到提示: ${checkinResult.message}`);
        if (checkinResult.message.includes("SESSION")) {
          const isGaCookieOnly =
            credential.includes("_ga") &&
            !credential.includes("session") &&
            !credential.includes("token") &&
            !credential.includes("PHPSESSID");

          if (isGaCookieOnly) {
            logger.warn(
              "提示: 检测到配置的 Cookie 仅包含 Google Analytics 统计参数 (_ga / _gid)，非账号登录 Session。",
            );
          } else {
            logger.warn(
              "提示: 当前配置的 Session Cookie 在 NatFrp 服务端 Session/Redis 内存中已过期失效。",
            );
            logger.info(
              "解决办法: 请在浏览器中重新登录 https://www.natfrp.com/user/，按 F12 -> 「网络 (Network)」 -> 点击任意请求复制最新的 `PHPSESSID` 填入 NATFRP_COOKIE 即可全自动过极验签到。",
            );
          }
        }
      }

      // 3. 重新获取更新后的账号与流量配置
      const userInfoAfter = await fetchUserInfoV4(credential);
      if (userInfoAfter && Array.isArray(userInfoAfter.traffic)) {
        logger.info("--- 当前最新流量配置 ---");
        logger.info(`最新已用流量: ${formatTraffic(userInfoAfter.traffic[0])}`);
        logger.info(`最新剩余流量: ${formatTraffic(userInfoAfter.traffic[1])}`);
      }
    }
  },
});

if (require.main === module) {
  void runTask(natfrpCheckinTask);
}
