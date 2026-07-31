// name: "云·原神自动签到与时长查询"
// cron "12 8 * * *" script-path=scripts/cloudgame_genshin_checkin.ts,tag=ql-scripts
// @name 云·原神自动签到与时长查询
// @description 米哈游云·原神账号自动登录、领取每日签到奖励并查询免费时长
// @cron 12 8 * * *

/**
 * ==================== 云·原神签到与时长查询使用说明 ====================
 * 1. 任务用途：
 *    - 基于账号密码自动登录米哈游云·原神，复刻官方登录流程。
 *    - 若登录触发 GeeTest v4 滑块验证码（极验 aigis），脚本会离线解算
 *      缺口偏移并构造校验参数直接通过，无需浏览器或打码平台。
 *    - 查询免费时长、畅玩卡状态、原点余额；领取每日登录奖励。
 *
 * 2. 环境变量配置：
 *    - 推荐 Token 模式（与 MHYY Python 项目相同，避免账号密码登录触发极验）：
 *      - `YS_CG_TOKEN`: 抓包得到的完整 `x-rpc-combo_token` 值。
 *      - `YS_CG_DEVICE_ID`: 与 Token 同次请求中的 `x-rpc-device_id`；与 Token 按顺序对应。
 *      - 可选：`YS_CG_CLIENT_TYPE`、`YS_CG_SYS_VERSION`、`YS_CG_DEVICE_NAME`、
 *        `YS_CG_DEVICE_MODEL`、`YS_CG_APP_VERSION`，均应使用同次抓包值。
 *    - 兼容密码模式：`YS_CG_ACCOUNT` 与 `YS_CG_PASSWORD` 按顺序一一对应。
 *      若服务端下发 `captcha_type=icon`，请改用上述 Token 模式，脚本不会尝试绕过图标验证。
 *    - 多账号均用换行或 `&` 分隔；账号内的邮箱 `@` 不会被当作分隔符。
 *
 * 3. 运行环境：
 *    - 极验 v4 缺口识别经 pngjs 解码 PNG + Scharr/ZNCC 模板匹配实现，零 native 依赖、零无头浏览器。
 *    - 米哈游账号密码经 RSA-1024 + 自定义 base64 加密提交，全部使用 Node 内置 crypto。
 *    - 每天 08:12 触发；任务启动后随机延迟 1–30 秒。
 * ===========================================================================
 */

import {
  defineTask,
  randomDelayBetween,
  runTask,
  sleep,
} from "../src/core/task";
import { optionalEnv, requiredEnv } from "../src/core/env";
import { formatTime } from "../src/core/time";
import {
  MiHoYoApiClient,
  assertCloudgameOk,
  createDirectTokenSession,
  type CloudgameNotification,
  type CloudgameSessionContext,
  loginWithPassword,
  type WalletInfoLike,
} from "../src/core/mihoyo/client";
import { HttpSession } from "../src/core/mihoyo/http";

/** 将多账号变量按换行或 & 拆分（不拆分邮箱中的 @）。 */
function splitPairs(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\n&]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

interface WalletStat {
  freeMinutes: number;
  playCardMsg: string;
  coinNum: number;
  coinMinutes: number;
}

/** 将接口下发的数值字段（可能是 string 或 number）解析为有限数字。 */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** 解析钱包响应体为可读统计；freeMinutes / coinNum 为 -1 表示字段缺失。 */
export function parseWallet(wallet: WalletInfoLike): WalletStat {
  const freeMinutes = toFiniteNumber(wallet.data?.free_time?.free_time);
  const coinNum = toFiniteNumber(wallet.data?.coin?.coin_num);
  return {
    freeMinutes: freeMinutes ?? -1,
    playCardMsg: wallet.data?.play_card?.short_msg || "未知",
    coinNum: coinNum ?? -1,
    // 原点 coin_num 每 10 点约 1 分钟（云原神常规换算）
    coinMinutes: coinNum === undefined ? 0 : coinNum / 10,
  };
}

export function formatMinutes(stat: WalletStat): string {
  const free = stat.freeMinutes >= 0 ? `${stat.freeMinutes} 分钟` : "未知";
  const coin =
    stat.coinNum >= 0
      ? `${stat.coinNum} 点（约 ${stat.coinMinutes.toFixed(0)} 分钟）`
      : "未知";
  return `免费时长 ${free} | 畅玩卡 ${stat.playCardMsg} | 原点 ${coin}`;
}

/** 弹窗通知 msg 字段内嵌的 JSON 载荷。 */
interface NotificationPayload {
  msg?: string;
  num?: number;
  over_num?: number;
}

/**
 * 解析弹窗通知中的奖励说明。
 *
 * msg 字段本身是一段 JSON 字符串，形如
 * `{"msg":"每日登录奖励","num":600,"over_num":0}`；
 * 非 JSON 或结构不符时返回 undefined，由调用方退回钱包差值。
 */
export function parseNotificationReward(
  notification: CloudgameNotification,
): string | undefined {
  const raw = notification.msg;
  if (!raw) return undefined;

  let payload: NotificationPayload;
  try {
    payload = JSON.parse(raw) as NotificationPayload;
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== "object") return undefined;

  const num = toFiniteNumber(payload.num);
  const overNum = toFiniteNumber(payload.over_num) ?? 0;
  const label = payload.msg;
  if (num === undefined) return label || undefined;

  if (overNum > 0) {
    return `${label || "签到奖励"}：获得 ${num} 分钟（免费时长已达上限，超出 ${overNum} 分钟）`;
  }
  return `${label || "签到奖励"}：获得 ${num} 分钟`;
}

/** 领取每日签到奖励并回报本次新增免费时长。 */
async function claimCheckinRewards(
  client: MiHoYoApiClient,
  ctx: CloudgameSessionContext,
  beforeMinutes: number,
  info: (m: string) => void,
  warn: (m: string) => void,
): Promise<void> {
  // 复刻客户端调用顺序：读取弹窗前先请求公告。失败不影响签到。
  try {
    await client.getAnnouncementInfo(ctx);
  } catch (error) {
    warn(
      `获取公告信息失败（已忽略）：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const notifications = await client.listNotifications(ctx);
  assertCloudgameOk(notifications, "获取签到弹窗");

  const list = notifications.data?.list ?? [];
  if (list.length === 0) {
    info("今日已签到或无新奖励。");
    return;
  }

  const rewards: string[] = [];
  for (const notif of list) {
    const id = notif.id ?? "";
    if (!id) continue;
    assertCloudgameOk(await client.ackNotification(ctx, id), "领取签到奖励");
    const reward = parseNotificationReward(notif);
    if (reward) rewards.push(reward);
  }

  for (const reward of rewards) info(reward);

  // 领取后钱包有短暂延迟，稍等再读一次以计算差值。
  await sleep(1_000);
  let after: WalletStat;
  try {
    const wallet = await client.getWallet(ctx);
    assertCloudgameOk(wallet, "查询钱包");
    after = parseWallet(wallet);
  } catch (error) {
    warn(
      `签到已完成，但复查钱包失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  if (beforeMinutes >= 0 && after.freeMinutes >= 0) {
    let earned = after.freeMinutes - beforeMinutes;
    if (earned < 0) {
      warn(`免费时长异常减少：${beforeMinutes} -> ${after.freeMinutes}`);
      earned = 0;
    }
    info(
      `签到完成：本次获得 ${earned} 分钟，当前免费时长 ${after.freeMinutes} 分钟。`,
    );
    return;
  }

  if (after.freeMinutes >= 0) {
    info(`签到完成，当前免费时长 ${after.freeMinutes} 分钟。`);
    return;
  }
  info(
    rewards.length > 0
      ? "签到完成（奖励详情见上方通知）。"
      : "签到完成，但未能计算本次新增免费时长。",
  );
}

function valueAt(
  values: readonly string[],
  index: number,
  fallback: string,
): string {
  return values[index] || (values.length === 1 ? values[0]! : fallback);
}

async function queryAndClaim(
  client: MiHoYoApiClient,
  ctx: CloudgameSessionContext,
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  },
): Promise<void> {
  let wallet: WalletInfoLike;
  try {
    wallet = await client.getWallet(ctx);
    assertCloudgameOk(wallet, "查询钱包");
  } catch (error) {
    logger.error(
      `查询钱包失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  const before = parseWallet(wallet);
  logger.info(`当前钱包：${formatMinutes(before)}`);
  if (before.freeMinutes < 0) {
    logger.warn("钱包响应缺少免费时长字段，接口结构可能已变更。");
  }

  try {
    await claimCheckinRewards(
      client,
      ctx,
      before.freeMinutes,
      logger.info,
      logger.warn,
    );
  } catch (error) {
    logger.error(
      `领取签到奖励失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const cloudgameCheckinTask = defineTask({
  async run({ logger }) {
    const startupDelay = randomDelayBetween(1_000, 30_000);
    logger.info(`随机延迟 ${(startupDelay / 1000).toFixed(1)} 秒后开始签到。`);
    await sleep(startupDelay);
    logger.info(`${formatTime()} 读取云·原神账号配置`);

    const tokenValues = splitPairs(optionalEnv("YS_CG_TOKEN"));
    const deviceIds = splitPairs(optionalEnv("YS_CG_DEVICE_ID"));
    const clientTypes = splitPairs(optionalEnv("YS_CG_CLIENT_TYPE"));
    const sysVersions = splitPairs(optionalEnv("YS_CG_SYS_VERSION"));
    const deviceNames = splitPairs(optionalEnv("YS_CG_DEVICE_NAME"));
    const deviceModels = splitPairs(optionalEnv("YS_CG_DEVICE_MODEL"));
    const appVersions = splitPairs(optionalEnv("YS_CG_APP_VERSION"));

    if (tokenValues.length > 0) {
      if (deviceIds.length === 0) {
        throw new Error("使用 YS_CG_TOKEN 时必须同时配置 YS_CG_DEVICE_ID");
      }
      if (deviceIds.length !== 1 && deviceIds.length !== tokenValues.length) {
        throw new Error(
          "YS_CG_DEVICE_ID 数量必须为 1 或与 YS_CG_TOKEN 数量一致",
        );
      }

      logger.info(`读取到 ${tokenValues.length} 个云·原神 Token 会话。`);
      for (const [index, token] of tokenValues.entries()) {
        logger.info(
          `---------------- Token 会话 [${index + 1}/${tokenValues.length}] ----------------`,
        );
        const session = new HttpSession();
        const client = new MiHoYoApiClient(session);
        const ctx = createDirectTokenSession({
          comboToken: token,
          deviceId: valueAt(deviceIds, index, ""),
          clientType: valueAt(clientTypes, index, "5"),
          sysVersion: valueAt(sysVersions, index, "14.0"),
          deviceName: valueAt(deviceNames, index, "Unknown"),
          deviceModel: valueAt(deviceModels, index, "Unknown"),
          appVersion: valueAt(appVersions, index, "5.0.0"),
        });
        logger.info("使用已配置的 Token 会话查询签到状态。");
        await queryAndClaim(client, ctx, logger);
      }
      return;
    }

    const accounts = splitPairs(requiredEnv("YS_CG_ACCOUNT"));
    const passwords = splitPairs(requiredEnv("YS_CG_PASSWORD"));
    if (accounts.length === 0) return;
    if (accounts.length !== passwords.length) {
      logger.warn(
        `账号数量(${accounts.length})与密码数量(${passwords.length})不一致，将逐账号尝试。`,
      );
    }

    for (const [index, account] of accounts.entries()) {
      logger.info(
        `---------------- 账号 [${index + 1}/${accounts.length}] ----------------`,
      );
      const password = passwords[index] ?? "";
      if (!password) {
        logger.warn("该账号未配置对应密码，跳过。");
        continue;
      }

      const session = new HttpSession();
      const client = new MiHoYoApiClient(session);
      const log = {
        info: (m: string) => logger.info(m),
        warn: (m: string) => logger.warn(m),
        error: (m: string) => logger.error(m),
      };

      let ctx: CloudgameSessionContext | null;
      try {
        ctx = await loginWithPassword(session, client, account, password, log);
      } catch (error) {
        logger.error(
          `登录流程异常：${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (!ctx) {
        logger.error("登录失败，已跳过该账号签到。");
        continue;
      }
      logger.info("云·原神登录成功。");

      await queryAndClaim(client, ctx, logger);
    }
  },
  name: "云·原神自动签到与时长查询",
});

if (require.main === module) {
  void runTask(cloudgameCheckinTask);
}
