/**
 * 米哈游云·原神 API 客户端。
 *
 * 移植自 cloudgame_checkin main.cpp::MiHoYoApiClient / HeaderBuilder / FullLoginStrategy。
 * 链路：初始化设备 → getFp → webVerify(快路径) → 否则 loginByPassword
 *   (遇 -3101 触发 aigis 极验 → 解算后重试) → webLogin 取 combo_token
 *   → 云游戏 login → wallet(n) / listNotifications + ackNotification 领签到。
 */
import crypto from "node:crypto";
import { type HttpSession, type MiHoYoResponse } from "./http";
import { buildComboToken, encryptAccountOrPassword, randomHex } from "./crypto";
import { solveAigisCaptcha } from "../captcha/geetest_v4";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0";

const URLS = {
  fp: "https://public-data-api.mihoyo.com/device-fp/api/getFp",
  verify:
    "https://passport-api.mihoyo.com/account/ma-cn-session/web/webVerifyForGame",
  loginPwd:
    "https://passport-api.mihoyo.com/account/ma-cn-passport/web/loginByPassword",
  webLogin: "https://hk4e-sdk.mihoyo.com/hk4e_cn/combo/granter/login/webLogin",
  cgLogin: "https://api-cloudgame.mihoyo.com/hk4e_cg_cn/gamer/api/login",
  wallet: "https://api-cloudgame.mihoyo.com/hk4e_cg_cn/wallet/wallet/get",
  notif:
    "https://api-cloudgame.mihoyo.com/hk4e_cg_cn/gamer/api/listNotifications?status=NotificationStatusUnread&type=NotificationTypePopup&is_sort=true",
  ack: "https://api-cloudgame.mihoyo.com/hk4e_cg_cn/gamer/api/ackNotification",
};

export interface DeviceProfile {
  deviceId: string;
  seedId: string;
  seedTime: string;
  deviceFp: string;
  lifecycleId: string;
  webappLifecycleId: string;
}

export interface SessionContext {
  device: DeviceProfile;
  openId: string;
  comboTokenRaw: string;
}

export interface WalletInfoLike {
  data?: {
    free_time?: { free_time?: string };
    play_card?: { short_msg?: string };
    coin?: { coin_num?: string };
  };
}

type ScalarHeaders = Record<string, string>;

function baseHeaders(): ScalarHeaders {
  return {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "sec-ch-ua":
      '"Not;A=Brand";v="8", "Chromium";v="150", "Microsoft Edge";v="150"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  };
}

export interface MiHoYoApiResult<T> {
  success: boolean;
  retcode: number;
  message: string;
  data: T;
}

export class MiHoYoApiClient {
  constructor(private session: HttpSession) {}

  /** 拉取设备指纹。 */
  async getDeviceFp(device: DeviceProfile): Promise<string> {
    const extFields = {
      userAgent: UA,
      browserScreenSize: "1981440",
      maxTouchPoints: "0",
      isTouchSupported: "0",
      browserLanguage: "zh-CN",
      browserPlat: "Win32",
      browserTimeZone: "Asia/Shanghai",
      webGlRender:
        "ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
      webGlVendor: "Google Inc. (Intel)",
      numOfPlugins: "5",
      listOfPlugins: [
        "PDF Viewer",
        "Chrome PDF Viewer",
        "Chromium PDF Viewer",
        "Microsoft Edge PDF Viewer",
        "WebKit built-in PDF",
      ],
      screenRatio: "1",
      deviceMemory: "16",
      hardwareConcurrency: "12",
      cpuClass: "unknown",
      ifNotTrack: "unknown",
      ifAdBlock: "0",
      hasLiedLanguage: "0",
      hasLiedResolution: "0",
      hasLiedOs: "0",
      hasLiedBrowser: "0",
      canvas: randomHex(32),
      webDriver: "0",
      colorDepth: "24",
      pixelRatio: "1",
      packageName: "unknown",
      packageVersion: "2.54.0",
      webgl: randomHex(32),
    };

    const currentFp = device.deviceFp || randomHex(13);
    const payload = {
      device_id: device.deviceId,
      seed_id: device.seedId,
      seed_time: device.seedTime,
      platform: "22",
      device_fp: currentFp,
      app_name: "hk4e_cn",
      ext_fields: JSON.stringify(extFields),
    };

    const headers = {
      ...baseHeaders(),
      Origin: "https://ys.mihoyo.com",
      Referer: "https://ys.mihoyo.com/",
    };
    const resp = await this.session.post<unknown>(
      URLS.fp,
      headers,
      JSON.stringify(payload),
    );
    if (resp.status !== 200) throw new Error(`getFp HTTP ${resp.status}`);
    const j = resp.data as { data?: { device_fp?: string } };
    if (!j.data?.device_fp) throw new Error("getFp 未返回 device_fp");
    return j.data.device_fp;
  }

  /** webVerifyForGame：会话仍有效时走快路径拿 aid。 */
  async webVerifyForGame(
    device: DeviceProfile,
  ): Promise<MiHoYoApiResult<{ user_info?: { aid?: string } }>> {
    const traceInfo = JSON.stringify({
      webapp_lifecycle_id: device.webappLifecycleId,
    });
    this.session.cookies.set(
      "MIHOYO_LOGIN_PLATFORM_COMMON_TRACE_INFO",
      encodeURIComponent(traceInfo),
      "mihoyo.com",
    );

    const headers: ScalarHeaders = {
      ...baseHeaders(),
      Origin: "https://ys.mihoyo.com",
      Referer: "https://ys.mihoyo.com/",
      "x-rpc-device_id": device.deviceId,
      "x-rpc-device_fp": device.deviceFp,
      "x-rpc-device_model": "Microsoft%20Edge%20150.0.0.0",
      "x-rpc-device_name": "Microsoft%20Edge",
      "x-rpc-device_os": "Windows%2010%2064-bit",
      "x-rpc-app_id": "c76ync6mutq8",
      "x-rpc-app_version": "",
      "x-rpc-client_type": "22",
      "x-rpc-sdk_version": "2.50.1",
      "x-rpc-game_biz": "hk4e_cn",
      "x-rpc-lifecycle_id": device.lifecycleId,
      "x-rpc-mi_referrer": "https://ys.mihoyo.com/cloud/#/",
    };
    const resp = await this.session.post(URLS.verify, headers, "");
    const data = resp.data as MiHoYoApiResult<{ user_info?: { aid?: string } }>;
    return ensureShape(data);
  }

  /** 密码登录，可携带 aigis token 重试。 */
  async loginByPassword(
    device: DeviceProfile,
    encAccount: string,
    encPassword: string,
    aigisToken = "",
  ): Promise<
    MiHoYoResponse<MiHoYoApiResult<{ combo_token?: string; aid?: string }>>
  > {
    const miReferrer =
      "https://user.mihoyo.com/login-platform/index.html" +
      "?client_type=22&app_id=c76ync6mutq8&theme=ys&token_type=4" +
      "&game_biz=hk4e_cn&message_origin=https%253A%252F%252Fys.mihoyo.com" +
      "&succ_back_type=message%253Alogin-platform%253Alogin-success" +
      "&fail_back_type=message%253Alogin-platform%253Alogin-fail" +
      "&ux_mode=popup&iframe_level=1&extra_trace=1#/login/password";

    const headers: ScalarHeaders = {
      ...baseHeaders(),
      Origin: "https://user.mihoyo.com",
      Referer: "https://user.mihoyo.com/",
      "x-rpc-device_id": device.deviceId,
      "x-rpc-device_fp": device.deviceFp,
      "x-rpc-device_model": "Microsoft%20Edge%20150.0.0.0",
      "x-rpc-device_name": "Microsoft%20Edge",
      "x-rpc-device_os": "Windows%2010%2064-bit",
      "x-rpc-app_id": "c76ync6mutq8",
      "x-rpc-app_version": "",
      "x-rpc-client_type": "22",
      "x-rpc-sdk_version": "2.54.0",
      "x-rpc-game_biz": "hk4e_cn",
      "x-rpc-lifecycle_id": device.lifecycleId,
      "x-rpc-mi_referrer": miReferrer,
      "x-rpc-source": "v2.webLogin",
    };
    if (aigisToken) headers["x-rpc-aigis"] = aigisToken;

    const body = JSON.stringify({
      account: encAccount,
      password: encPassword,
    });
    return this.session.post(URLS.loginPwd, headers, body);
  }

  /** webLogin 换 combo_token。 */
  async webLogin(
    device: DeviceProfile,
  ): Promise<MiHoYoApiResult<{ combo_token?: string }>> {
    const headers: ScalarHeaders = {
      ...baseHeaders(),
      Origin: "https://ys.mihoyo.com",
      Referer: "https://ys.mihoyo.com/",
      "x-rpc-device_id": device.deviceId,
      "x-rpc-device_fp": device.deviceFp,
      "x-rpc-client_type": "22",
      "x-rpc-game_biz": "hk4e_cn",
      "x-rpc-channel_id": "1",
      "x-rpc-language": "zh-cn",
      "x-rpc-mdk_version": "2.52.0",
    };
    const body = JSON.stringify({ app_id: 4, channel_id: 1 });
    const resp = await this.session.post<{ data?: { combo_token?: string } }>(
      URLS.webLogin,
      headers,
      body,
    );
    const j = resp.data as unknown as MiHoYoApiResult<{
      combo_token?: string;
    }> & {
      data?: { combo_token?: string };
      retcode?: number;
      message?: string;
    };
    return {
      success: resp.status === 200 && (j.retcode ?? -1) === 0,
      retcode: j.retcode ?? -1,
      message: j.message ?? "",
      data: j.data ?? {},
    };
  }

  /** 云游戏会话登录。 */
  async cloudgameLogin(ctx: SessionContext): Promise<MiHoYoApiResult<unknown>> {
    const headers = this.cloudgameHeaders(ctx);
    const resp = await this.session.post<{
      retcode?: number;
      message?: string;
    }>(URLS.cgLogin, headers, "");
    const j = resp.data;
    return {
      success: resp.status === 200 && (j.retcode ?? -1) === 0,
      retcode: j.retcode ?? -1,
      message: j.message ?? "",
      data: {},
    };
  }

  /** 查询钱包（免费时长 / 畅玩卡 / 原点）。 */
  async getWallet(ctx: SessionContext): Promise<WalletInfoLike> {
    const headers = this.cloudgameHeaders(ctx);
    return this.session.get(URLS.wallet, headers);
  }

  /** 列出未读签到弹窗奖励。 */
  async listNotifications(
    ctx: SessionContext,
  ): Promise<MiHoYoResponse<{ data?: { list?: Array<{ id?: string }> } }>> {
    const headers = this.cloudgameHeaders(ctx);
    return this.session.get<{ data?: { list?: Array<{ id?: string }> } }>(
      URLS.notif,
      headers,
    );
  }

  /** 确认（领取）指定签到奖励。 */
  async ackNotification(
    ctx: SessionContext,
    rewardId: string,
  ): Promise<MiHoYoResponse<unknown>> {
    const headers = this.cloudgameHeaders(ctx);
    return this.session.post(
      URLS.ack,
      headers,
      JSON.stringify({ id: rewardId }),
    );
  }

  private cloudgameHeaders(ctx: SessionContext): ScalarHeaders {
    const combo = buildComboToken(ctx.openId, ctx.comboTokenRaw);
    return {
      ...baseHeaders(),
      Origin: "https://ys.mihoyo.com",
      Referer: "https://ys.mihoyo.com/",
      "x-rpc-app_id": "4",
      "x-rpc-combo_token": combo,
      "x-rpc-device_id": ctx.device.deviceId,
      "x-rpc-cg_game_biz": "hk4e_cn",
      "x-rpc-channel": "mihoyo",
      "x-rpc-client_type": "16",
      "x-rpc-cps": "pc_mihoyo",
      "x-rpc-device_model": "Unknown",
      "x-rpc-device_name": "Unknown",
      "x-rpc-language": "zh-cn",
      "x-rpc-op_biz": "clgm_cn",
      "x-rpc-sys_version": "Windows 10",
      "x-rpc-vendor_id": "2",
    };
  }
}

function ensureShape<T>(data: unknown): MiHoYoApiResult<T> {
  const j = data as MiHoYoApiResult<T> & {
    retcode?: number;
    message?: string;
    data?: T;
  };
  return {
    success: (j.retcode ?? -1) === 0,
    retcode: j.retcode ?? -1,
    message: j.message ?? "",
    data: (j.data ?? ({} as T)) as T,
  };
}

/** 生成全新随机设备身份。 */
export function newDevice(): DeviceProfile {
  return {
    deviceId: crypto.randomUUID(),
    seedId: randomHex(16),
    seedTime: Date.now().toString(),
    deviceFp: "",
    lifecycleId: randomHex(10),
    webappLifecycleId: crypto.randomUUID(),
  };
}

/** 登录门面：完整密码登录 + aigis 极验重试，返回云游戏会话上下文。 */
export async function loginWithPassword(
  session: HttpSession,
  client: MiHoYoApiClient,
  account: string,
  password: string,
  logger?: {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  },
): Promise<SessionContext | null> {
  const log = logger ?? { info: () => {}, warn: () => {}, error: () => {} };

  const device = newDevice();
  session.cookies.set("_MHYUUID", device.deviceId, "mihoyo.com");
  session.cookies.set("DEVICEFP_SEED_ID", device.seedId, "mihoyo.com");
  session.cookies.set("DEVICEFP_SEED_TIME", device.seedTime, "mihoyo.com");
  session.cookies.set(
    "MIHOYO_LOGIN_PLATFORM_LIFECYCLE_ID",
    device.lifecycleId,
    "mihoyo.com",
  );

  const fp = await client.getDeviceFp(device);
  device.deviceFp = fp;
  session.cookies.set("DEVICEFP", fp, "mihoyo.com");

  const cached = await client.webVerifyForGame(device);
  if (cached.success && cached.data.user_info?.aid) {
    log.info("检测到有效会话（快路径）。");
    return await finish(session, client, device, cached.data.user_info.aid);
  }

  log.info("无有效会话，进行账号密码登录。");
  const encAccount = encryptAccountOrPassword(account);
  const encPassword = encryptAccountOrPassword(password);

  let loginResp = await client.loginByPassword(device, encAccount, encPassword);
  let lj = ensureShape<{ combo_token?: string; aid?: string }>(loginResp.data);

  if (loginResp.status === 200 && lj.retcode === -3101) {
    log.info("登录触发极验 aigis (-3101)，开始解算滑块...");
    if (!loginResp.aigisHeader) {
      log.error("响应缺少 x-rpc-aigis 报头，无法解算验证码。");
      return null;
    }
    const aigisToken = await solveAigisCaptcha(loginResp.aigisHeader);
    log.info("极验解算完成，重新提交登录。");
    loginResp = await client.loginByPassword(
      device,
      encAccount,
      encPassword,
      aigisToken,
    );
    lj = ensureShape<{ combo_token?: string }>(loginResp.data);
  }

  if (!(loginResp.status === 200 && lj.success)) {
    log.error(`密码登录失败：${lj.message || "未知错误"}`);
    return null;
  }

  const aid = lj.data.aid ?? "";
  if (!aid) {
    log.error("登录响应未返回 aid，无法继续。");
    return null;
  }

  const verified = await client.webVerifyForGame(device);
  if (!verified.success || !verified.data.user_info?.aid) {
    log.error("登录后二次校验失败。");
    return null;
  }

  return await finish(session, client, device, verified.data.user_info.aid);
}

async function finish(
  session: HttpSession,
  client: MiHoYoApiClient,
  device: DeviceProfile,
  openId: string,
): Promise<SessionContext | null> {
  const webLogin = await client.webLogin(device);
  if (!webLogin.success || !webLogin.data.combo_token) {
    return null;
  }
  const ctx: SessionContext = {
    device,
    openId,
    comboTokenRaw: webLogin.data.combo_token,
  };
  const cg = await client.cloudgameLogin(ctx);
  if (!cg.success) return null;
  return ctx;
}
