// name: "NatFrp 每日签到与流量查询"
// cron "12 8 * * *" script-path=scripts/natfrp_daily_checkin.ts,tag=ql-scripts
// @name NatFrp 每日签到与流量查询
// @description NatFrp（樱花 Frp）每日自动签到并查询账号流量与会员信息
// @cron 12 8 * * *

/**
 * ==================== NatFrp 签到与流量查询脚本使用说明 ====================
 * 1. 任务用途：
 *    - 基于官方 NatFrp API v4 自动查询账号剩余流量、已用流量及会员组配置。
 *    - 自动提交每日签到请求；服务端要求极验 3 滑块时自动完成校验后提交。
 *
 * 2. 环境变量配置：
 *    - `NATFRP_TOKEN`: NatFrp 访问密钥 / Token (支持获取流量与账号配置)。
 *    - `NATFRP_COOKIE`: NatFrp 网页端 Session Cookie (用于检查并尝试签到)。
 *    - 查询信息可使用 Token 或 Cookie；自动签到必须配置 Cookie。
 *    - 两者可以同时配置，多账号使用 `&` 或换行分隔并按顺序对应。
 *
 * 3. 运行环境：
 *    - 纯 Node.js 运行，零第三方打码 API、零无头浏览器依赖。
 *    - 极验 3 滑块通过 pngjs 缺口识别 + Node vm 执行 RC4/RSA 加密 JS 离线解算，
 *      完整复刻官方 api.geetest.com 的两次 get.php + ajax.php 链路拿真实 validate。
 *    - 每天 08:12 触发；任务启动后随机延迟 1–30 秒。
 * ===========================================================================
 */

import axios, { type AxiosRequestConfig } from "axios";
import { optionalEnv, requiredEnv, splitAccounts } from "../src/core/env";
import { solveGeetestV3Slider } from "../src/core/captcha/geetest_v3";
import { request, requestWithResponse } from "../src/core/http";
import {
  defineTask,
  randomDelayBetween,
  runTask,
  sleep,
} from "../src/core/task";
import { formatTime } from "../src/core/time";

/** 极验服务偶发返回 fail 时，首次尝试之外的最大重试次数。 */
export const NATFRP_CAPTCHA_MAX_RETRIES = 5;
/** 两次极验解算尝试之间的等待时间。 */
export const NATFRP_CAPTCHA_RETRY_DELAY_MS = 30_000;

type NatFrpCaptchaSolver = typeof solveGeetestV3Slider;

/**
 * 极验 ajax.php 偶发不会返回 validate。对此重试完整的本地滑块解算，
 * 避免单次服务端瞬时失败直接终止每日任务。
 */
export async function solveNatFrpCaptchaWithRetry(
  gt: string,
  challenge: string,
  logger: { warn(message: string): void },
  solver: NatFrpCaptchaSolver = solveGeetestV3Slider,
  wait: (milliseconds: number) => Promise<void> = sleep,
) {
  for (let attempt = 0; attempt <= NATFRP_CAPTCHA_MAX_RETRIES; attempt += 1) {
    try {
      return await solver(gt, challenge, "https://www.natfrp.com/user/");
    } catch (error) {
      if (attempt === NATFRP_CAPTCHA_MAX_RETRIES) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `极验解算第 ${attempt + 1} 次失败：${message}；30 秒后进行第 ${attempt + 2} 次尝试（最多重试 ${NATFRP_CAPTCHA_MAX_RETRIES} 次）。`,
      );
      await wait(NATFRP_CAPTCHA_RETRY_DELAY_MS);
    }
  }

  throw new Error("极验解算重试流程意外结束");
}

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
export function maskUsername(value: string | undefined): string {
  if (!value) return "***";
  if (value.includes("@")) {
    const parts = value.split("@");
    const user = parts[0] || "";
    const domain = parts.slice(1).join("@");
    const maskedUser =
      user.length > 2 ? `${user.slice(0, 2)}***` : `${user}***`;
    return `${maskedUser}@${domain}`;
  }
  if (value.length <= 2) return `${value}***`;
  return `${value.slice(0, 2)}***${value.slice(-1)}`;
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

export interface NatFrpGeetestConfig {
  gt?: string;
  challenge?: string;
  new_captcha?: boolean;
  success?: boolean | number;
}

export function buildNatFrpCaptchaRequest(
  credential: string,
): AxiosRequestConfig {
  return {
    url: "https://www.natfrp.com/cgi/v4/user/sign?gt",
    method: "GET",
    headers: buildNatFrpSessionHeaders(credential),
  };
}

export async function getNatFrpCheckinRequirement(credential: string): Promise<{
  needCaptcha: boolean;
  message: string;
  gt?: string | undefined;
  challenge?: string | undefined;
}> {
  try {
    const response = await request<
      NatFrpApiResponse<NatFrpGeetestConfig> | NatFrpGeetestConfig
    >(buildNatFrpCaptchaRequest(credential));
    const wrapper = response as NatFrpApiResponse<NatFrpGeetestConfig>;
    // /sign?gt 的响应为平铺结构：{ online, gt, challenge, new_captcha }，
    // 不在 data 子层；wrapper.data 兜底以兼容可能的包裹形态。
    const config = wrapper.data || (response as NatFrpGeetestConfig);
    const gt = config.gt;
    const challenge = config.challenge;
    const needCaptcha = Boolean(gt || challenge);
    const message = wrapper.msg || wrapper.message || "";

    return {
      needCaptcha,
      gt,
      challenge,
      message:
        message ||
        (needCaptcha ? "签到需要完成极验交互验证" : "签到无需极验验证"),
    };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.data) {
      const data = error.response.data as NatFrpApiResponse;
      return {
        needCaptcha: false,
        message: data.msg || data.message || error.message,
      };
    }
    return {
      needCaptcha: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
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
    const response = await requestWithResponse<
      NatFrpApiResponse<{ gt?: string; challenge?: string }>
    >(buildNatFrpCheckinRequest(credential, captchaParams));
    const res = response.data;

    const msg = res.msg || res.message || "签到请求已受理";
    const gt = res.data?.gt;
    const challenge = res.data?.challenge;

    if (
      response.status >= 200 &&
      response.status < 300 &&
      (res.code === undefined || res.code === 200) &&
      (res.status === undefined || res.status === 200) &&
      res.flag !== false
    ) {
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
  async run({ logger }) {
    const startupDelay = randomDelayBetween(1_000, 30_000);
    logger.info(`随机延迟 ${(startupDelay / 1000).toFixed(1)} 秒后开始签到。`);
    await sleep(startupDelay);
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
      let alreadySignedToday = false;
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
          alreadySignedToday = Boolean(userInfoBefore.sign.signed);
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
      if (alreadySignedToday) {
        logger.info("今日已完成签到，跳过极验与重复提交。");
        continue;
      }
      if (!cookieEnv) {
        logger.warn(
          "未配置 NATFRP_COOKIE，Token 只能查询账号信息，已跳过自动签到。",
        );
        continue;
      }

      logger.info("正在检查或初始化签到极验校验参数...");
      const requirement = await getNatFrpCheckinRequirement(credential);

      let checkinResult: {
        success: boolean;
        message: string;
        needCaptcha?: boolean | undefined;
        gt?: string | undefined;
        challenge?: string | undefined;
      };

      if (requirement.needCaptcha) {
        logger.info(
          `触发极验拼图验证，正在离线解算极验 3 滑块缺口与算力校验码...`,
        );
        // challenge 必须由 /sign?gt 签发，客户端不可自造；自造脏值会被
        // 极验 nginx 层直接 403（不进业务逻辑）。
        const gt = requirement.gt || "78aaca6a49add69b47090ba07c00fa3a";
        if (!requirement.challenge) {
          logger.warn("极验 challenge 未下发，无法启动滑块解算，跳过签到");
          continue;
        }

        logger.info(`获取到极验参数 gt=${gt}，开始完整滑块协议链路解算...`);
        const captchaSolved = await solveNatFrpCaptchaWithRetry(
          gt,
          requirement.challenge,
          logger,
        );
        logger.info(
          `解算完成！极验下发的真实校验码: validate=${captchaSolved.validate.slice(0, 10)}...`,
        );

        logger.info("正在将极验解算参数发送至后端完成自动签到...");
        checkinResult = await executeCheckinV4(credential, {
          challenge: captchaSolved.challenge,
          validate: captchaSolved.validate,
          seccode: captchaSolved.seccode,
        });
      } else {
        logger.info("当前账号无需极验，正在提交自动签到...");
        checkinResult = await executeCheckinV4(credential, undefined);
      }

      if (!checkinResult.success && checkinResult.needCaptcha) {
        logger.info("二次补尝：重新解算极验滑块并发送...");
        const gt =
          checkinResult.gt ||
          requirement.gt ||
          "78aaca6a49add69b47090ba07c00fa3a";
        if (!checkinResult.challenge) {
          logger.warn("二次补尝缺少极验 challenge，无法解算，跳过");
          continue;
        }
        const captchaSolved = await solveNatFrpCaptchaWithRetry(
          gt,
          checkinResult.challenge,
          logger,
        );

        checkinResult = await executeCheckinV4(credential, {
          challenge: captchaSolved.challenge,
          validate: captchaSolved.validate,
          seccode: captchaSolved.seccode,
        });
      }

      if (checkinResult.success) {
        logger.info(`🎉 签到成功！结果: ${checkinResult.message}`);
      } else {
        logger.warn(`签到提示: ${checkinResult.message}`);
        if (checkinResult.message.includes("验证码校验失败")) {
          logger.info(
            "分析说明: 极验 validate 已解算并通过极验侧 ajax.php 校验，但 NatFrp 服务端二次校验仍拒绝。常见原因：缺口偏移识别偏差、challenge 已过期或 NatFrp 服务端风控。可观察日志中「解算完成」的 validate 是否为真实下发值后重试。",
          );
        } else if (checkinResult.message.includes("SESSION")) {
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
              "提示: 当前配置的 Session Cookie 在 NatFrp 服务端 Session 内存中已失效，请重新登录获取最新 Cookie。",
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
  name: "NatFrp 每日签到与流量查询",
});

if (require.main === module) {
  void runTask(natfrpCheckinTask);
}
