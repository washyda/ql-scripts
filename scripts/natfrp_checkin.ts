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
 *    - 自动提交每日签到请求；若服务端要求交互式极验，脚本会明确提示。
 *
 * 2. 环境变量配置：
 *    - `NATFRP_TOKEN`: NatFrp 访问密钥 / Token (支持获取流量与账号配置)。
 *    - `NATFRP_COOKIE`: NatFrp 网页端 Session Cookie (用于自动化极验拼图签到)。
 *    - 查询信息可使用 Token 或 Cookie；自动签到必须配置 Cookie。
 *    - 两者可以同时配置，多账号使用 `&` 或换行分隔并按顺序对应。
 *
 * 3. 运行环境：
 *    - 纯 Node.js 运行，零第三方打码 API、零无头浏览器依赖。
 * ===========================================================================
 */

import axios, { type AxiosRequestConfig } from "axios";
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

/**
 * 签到接口只接受 SESSION 鉴权。即使同时配置了 NATFRP_TOKEN，
 * 签到请求也不得携带 Authorization，否则服务端会按 Token 鉴权并拒绝。
 */
export function buildNatFrpSessionHeaders(
  cookie: string,
): Record<string, string> {
  const headers = buildNatFrpHeaders(cookie);
  delete headers["Authorization"];
  headers["Origin"] = "https://www.natfrp.com";
  headers["Referer"] = "https://www.natfrp.com/user/";
  return headers;
}

export function containsPhpSession(cookie: string): boolean {
  return /(?:^|;\s*)PHPSESSID=/iu.test(cookie);
}

export function buildNatFrpCheckinRequest(
  credential: string,
  captchaParams?: { challenge: string; validate: string; seccode: string },
): AxiosRequestConfig {
  const data: Record<string, unknown> = {};
  if (captchaParams) {
    data["geetest_challenge"] = captchaParams.challenge;
    data["geetest_validate"] = captchaParams.validate;
    data["geetest_seccode"] = captchaParams.seccode;
  }

  return {
    // 官网用户中心使用同源 /cgi/v4/ 网关；PHPSESSID 不能发往 api.natfrp.com。
    url: "https://www.natfrp.com/cgi/v4/user/sign",
    method: "POST",
    headers: buildNatFrpSessionHeaders(credential),
    data,
  };
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

/** 尝试发起自动签到请求 (支持提交极验验证码参数) */
export async function executeCheckinV4(
  credential: string,
  captchaParams?: { challenge: string; validate: string; seccode: string },
): Promise<{
  success: boolean;
  message: string;
  gt?: string | undefined;
  challenge?: string | undefined;
  needCaptcha?: boolean | undefined;
}> {
  try {
    const res = await request<
      NatFrpApiResponse<{ gt?: string; challenge?: string }>
    >(buildNatFrpCheckinRequest(credential, captchaParams));

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
    logger.info(
      `鉴权配置: Token=${tokenEnv ? "已识别" : "未配置"}，Cookie=${cookieEnv ? "已识别" : "未配置"}${cookieEnv ? `，PHPSESSID=${containsPhpSession(accounts[0] || "") ? "已识别" : "未识别"}` : ""}`,
    );

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
      if (!cookieEnv) {
        logger.warn(
          "未配置 NATFRP_COOKIE，Token 只能查询账号信息，已跳过自动签到。",
        );
        continue;
      }

      logger.info("正在使用纯 SESSION Cookie 请求 NatFrp 自动签到...");
      const checkinResult = await executeCheckinV4(credential, undefined);

      // 极验的 validate/seccode 必须由真实交互验证产生，不能本地伪造。
      if (!checkinResult.success && checkinResult.needCaptcha) {
        logger.warn(
          "签到接口要求完成极验交互验证，当前无头脚本无法安全生成有效的 validate/seccode，请在官网完成签到。",
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
              "提示: 官网 CGI 网关未接受当前 PHPSESSID；请确认 Cookie 来自 www.natfrp.com 当前登录会话且尚未失效。",
            );
            logger.info(
              "请退出后重新登录 https://www.natfrp.com/user/，再从 www.natfrp.com 的 Network 请求中复制完整 Cookie。",
            );
          }
        }
      }

      // 3. 重新获取更新后的账号与流量配置
      const userInfoAfter = await fetchUserInfoV4(credential, extraToken);
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
