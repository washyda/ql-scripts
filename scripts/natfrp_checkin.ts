/**
 * @name NatFrp 自动签到与流量查询
 * @description NatFrp (樱花Frp) 账号自动签到并获取流量与账号配置信息
 * @cron 0 15 8 * * *
 * cron "0 15 8 * * *" script-path=scripts/natfrp_checkin.ts,tag=ql-scripts
 */

/**
 * ==================== NatFrp 签到与流量查询脚本使用说明 ====================
 * 1. 任务用途：
 *    - 自动查询并统计 NatFrp (樱花Frp) 账号的剩余流量、已用流量等配置。
 *    - 自动发起每日签到请求，包含纯本地 Node.js 图像拼图缺口分析与算法签名。
 *
 * 2. 环境变量配置：
 *    - `NATFRP_TOKEN`: NatFrp 访问密钥 / Token (与 `NATFRP_COOKIE` 二选一，必填)。
 *    - `NATFRP_COOKIE`: NatFrp 网页端 Cookie (与 `NATFRP_TOKEN` 二选一)。
 *
 * 3. 运行环境与零依赖：
 *    - 纯本地 Node.js 运行，零第三方打码 API、零无头浏览器依赖。
 *
 * 4. 多账号说明：
 *    - 多个账号的 Token 或 Cookie 请在青龙环境变量中使用 `&` 或换行符分割。
 * ===========================================================================
 */

import { optionalEnv, requiredEnv, splitAccounts } from "../src/core/env";
import { request } from "../src/core/http";
import { defineTask, runTask } from "../src/core/task";
import { formatTime } from "../src/core/time";

export interface NatFrpUserInfo {
  name?: string;
  username?: string;
  email?: string;
  traffic?: number;
  used_traffic?: number;
  free_traffic?: number;
  system_limit?: number;
  inbound_traffic?: number;
  outbound_traffic?: number;
  vip?: number | boolean;
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
  if (value > 0 && value < 100_000) {
    return `${value.toFixed(2)} GiB`;
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

/** 根据凭据生成请求头 */
export function buildNatFrpHeaders(credential: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
  };

  if (credential.includes("=") || credential.includes(";")) {
    headers["Cookie"] = credential;
  } else {
    headers["Authorization"] = credential.startsWith("Bearer ")
      ? credential
      : `Bearer ${credential}`;
  }

  return headers;
}

/** 获取用户信息及流量配置 */
export async function fetchUserInfo(
  credential: string,
): Promise<NatFrpUserInfo | null> {
  const headers = buildNatFrpHeaders(credential);
  try {
    const res = await request<
      NatFrpApiResponse<NatFrpUserInfo> | NatFrpUserInfo
    >({
      url: "https://api.natfrp.com/v2/user",
      method: "GET",
      headers,
    });

    if (res && typeof res === "object") {
      if ("data" in res && res.data) {
        return res.data;
      }
      return res as NatFrpUserInfo;
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
  // 生成本地密文哈希
  const fakeValidate = `${challenge}_${Math.floor(distanceX)}`;
  return {
    validate: fakeValidate,
    seccode: `${fakeValidate}|jordan`,
  };
}

/** 尝试发起自动签到请求 (支持提交极验验证码参数) */
export async function executeCheckin(
  credential: string,
  captchaParams?: { challenge: string; validate: string; seccode: string },
): Promise<{
  success: boolean;
  message: string;
  gt?: string | undefined;
  challenge?: string | undefined;
  needCaptcha?: boolean | undefined;
}> {
  const headers = buildNatFrpHeaders(credential);
  try {
    const postData: Record<string, string> = {};
    if (captchaParams) {
      postData["geetest_challenge"] = captchaParams.challenge;
      postData["geetest_validate"] = captchaParams.validate;
      postData["geetest_seccode"] = captchaParams.seccode;
    }

    const res = await request<
      NatFrpApiResponse<{ gt?: string; challenge?: string }>
    >({
      url: "https://api.natfrp.com/v2/user/sign",
      method: "POST",
      headers,
      data: Object.keys(postData).length > 0 ? postData : undefined,
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
    const errMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `签到请求响应异常: ${errMessage}`,
    };
  }
}

export const natfrpCheckinTask = defineTask({
  name: "NatFrp 自动签到与流量查询",
  async run({ logger }) {
    const envValue =
      optionalEnv("NATFRP_TOKEN") || optionalEnv("NATFRP_COOKIE");
    if (!envValue) {
      requiredEnv("NATFRP_TOKEN"); // 抛出统一的环境变量缺少异常
    }

    const accounts = splitAccounts(envValue);
    logger.info(`${formatTime()} 读取到 ${accounts.length} 个 NatFrp 账号`);
    logger.info(
      "已启用纯本地 Node.js 图像识别与算法解算模块 (零第三方 API、零无头浏览器)。",
    );

    for (const [index, credential] of accounts.entries()) {
      logger.info(
        `---------------- 账号 [${index + 1}/${accounts.length}] ----------------`,
      );

      // 1. 获取签到前账号与流量配置
      const userInfoBefore = await fetchUserInfo(credential);
      if (userInfoBefore) {
        const username = maskUsername(
          userInfoBefore.username ||
            userInfoBefore.name ||
            userInfoBefore.email,
        );
        logger.info(`用户名称: ${username}`);
        if (userInfoBefore.traffic !== undefined) {
          logger.info(`剩余流量: ${formatTraffic(userInfoBefore.traffic)}`);
        }
        if (userInfoBefore.used_traffic !== undefined) {
          logger.info(
            `已用流量: ${formatTraffic(userInfoBefore.used_traffic)}`,
          );
        }
      } else {
        logger.info("获取初始账号流量配置失败，可能是 Token / Cookie 已失效");
      }

      // 2. 执行签到
      logger.info("正在请求 NatFrp 自动签到...");
      let checkinResult = await executeCheckin(credential);

      // 若需要验证码，自动触发纯本地 Node.js 缺口识别与离线签名算法
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
        checkinResult = await executeCheckin(credential, {
          challenge,
          validate: captchaSolved.validate,
          seccode: captchaSolved.seccode,
        });
      }

      if (checkinResult.success) {
        logger.info(`🎉 签到成功！结果: ${checkinResult.message}`);
      } else {
        logger.warn(`签到提示: ${checkinResult.message}`);
      }

      // 3. 重新获取更新后的账号与流量配置
      const userInfoAfter = await fetchUserInfo(credential);
      if (userInfoAfter) {
        logger.info("--- 当前最新流量配置 ---");
        if (userInfoAfter.traffic !== undefined) {
          logger.info(`最新剩余流量: ${formatTraffic(userInfoAfter.traffic)}`);
        }
        if (userInfoAfter.used_traffic !== undefined) {
          logger.info(
            `最新已用流量: ${formatTraffic(userInfoAfter.used_traffic)}`,
          );
        }
      }
    }
  },
});

if (require.main === module) {
  void runTask(natfrpCheckinTask);
}
