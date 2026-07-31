/**
 * 极验 3 标准滑块协议链路（官方 api.geetest.com）。
 *
 * 基于 geetest-crack 的 geetest_session.py 改造，适配官方标准 3.x 接口：
 *   1. 第一次 get.php：取初始 s/c 与验证类型信息。
 *   2. 第一次 ajax.php (step1)：校验进入滑块阶段。
 *   3. 第二次 get.php（is_next=slide3）：取带缺口/不带缺口图与新的 s/c。
 *   4. 缺口识别算 offset → 生成轨迹 → slide 加密生成 w。
 *   5. 第二次 ajax.php (step2)：提交 w 拿 validate。
 *
 * 关键：w 加密所用的 s 来自 get.php 响应中服务端下发的 s（官方标准接口语义），
 * 不能客户端自造；c 同理从响应取。
 */
import axios, { type AxiosInstance } from "axios";
import { calculateV3Offset } from "./geetest_v3_offset";
import {
  encodeTrajectory,
  encryptTrajectory,
  getGeetestV3Js,
  type GeetestTrajectoryPoint,
  type GeetestV3Js,
  type TrajectoryCipherParameters,
} from "./v3_js";

const API_SERVER = "api.geetest.com";
const STATIC_SERVER = "static.geetest.com";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface BrowserPerformanceTiming {
  navigationStart: number;
  unloadEventStart: number;
  unloadEventEnd: number;
  redirectStart: number;
  redirectEnd: number;
  fetchStart: number;
  domainLookupStart: number;
  domainLookupEnd: number;
  connectStart: number;
  secureConnectionStart: number;
  connectEnd: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
  domLoading: number;
  domInteractive: number;
  domContentLoadedEventStart: number;
  domContentLoadedEventEnd: number;
  domComplete: number;
  loadEventStart: number;
  loadEventEnd: number;
}

function generatePerformanceTiming(baseTimestamp = Date.now()): BrowserPerformanceTiming {
  const fetchStart = baseTimestamp + 1;
  const domainLookupStart = fetchStart + 4;
  const domainLookupEnd = domainLookupStart + 10;
  const connectStart = domainLookupEnd;
  const secureConnectionStart = connectStart + 38;
  const connectEnd = connectStart + 92;
  const requestStart = connectEnd + 3;
  const responseStart = requestStart + 54;
  const responseEnd = responseStart + 2;
  const unloadEventStart = responseEnd + 2;
  const unloadEventEnd = unloadEventStart + 3;
  const domLoading = unloadEventEnd + 2;
  const domInteractive = domLoading + 116;
  const domContentLoadedEventStart = domInteractive;
  const domContentLoadedEventEnd = domInteractive + 2;
  const domComplete = domContentLoadedEventEnd;
  const loadEventStart = domComplete;
  const loadEventEnd = loadEventStart + 2;

  return {
    navigationStart: baseTimestamp,
    unloadEventStart,
    unloadEventEnd,
    redirectStart: 0,
    redirectEnd: 0,
    fetchStart,
    domainLookupStart,
    domainLookupEnd,
    connectStart,
    secureConnectionStart,
    connectEnd,
    requestStart,
    responseStart,
    responseEnd,
    domLoading,
    domInteractive,
    domContentLoadedEventStart,
    domContentLoadedEventEnd,
    domComplete,
    loadEventStart,
    loadEventEnd,
  };
}

interface GeetestResponseData {
  status?: string;
  data?: {
    s?: string;
    c?: Array<number>;
    gt?: string;
    challenge?: string;
    bg?: string;
    fullbg?: string;
    slice?: string;
    result?: string;
    validate?: string;
    // init 下发的运行时服务器；slide 取图须改打该主机
    api_server?: string;
    static_servers?: Array<string>;
  };
  // 顶层也可能是平铺 s/c（get.php 旧格式）
  s?: string;
  c?: Array<number>;
  api_server?: string;
  static_servers?: Array<string>;
  // slide 出图响应顶层平铺（非 data 子层）
  challenge?: string;
  bg?: string;
  fullbg?: string;
  slice?: string;
  result?: string;
  validate?: string;
  gt?: string;
  // 错误响应载体：极验失败时多带 msg/error_code/desc 判定根因
  msg?: string;
  error_code?: string | number;
  desc?: string;
}

/** 把极验响应体压成可读字符串，便于错误信息里定位根因（error_code/msg/result 等）。 */
function describeResp(r: GeetestResponseData): string {
  return JSON.stringify({
    status: r.status,
    msg: r.msg,
    error_code: r.error_code,
    desc: r.desc,
    result: r.result ?? r.data?.result,
    data: r.data,
  });
}

function nowTimestamp(): string {
  return `${Date.now()}`;
}

function createClient(referer: string): AxiosInstance {
  return axios.create({
    timeout: 20_000,
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      Referer: referer,
      Origin: new URL(referer).origin,
    },
  });
}

/** 从 JSONP 文本解析出对象；若已是对象则直接返回。 */
function parsePayload(payload: unknown): GeetestResponseData {
  if (payload && typeof payload === "object") {
    return payload as GeetestResponseData;
  }
  const text = String(payload ?? "");
  const m = text.match(/\((.*)\)/s);
  const jsonStr = m ? m[1]! : text;
  return JSON.parse(jsonStr) as GeetestResponseData;
}

/** 根据 offset 生成一条拟真滑动轨迹 [[x, y, t], ...]。 */
function buildTrack(offset: number): GeetestTrajectoryPoint[] {
  const track: GeetestTrajectoryPoint[] = [
    [-32, -26, 0],
    [0, 0, 0],
  ];
  let x = 0;
  let t = 90;
  // 起步加速、中段匀速、末段减速；y 加小幅抖动拟真（人手滑动非纯水平）
  const steps = Math.max(20, Math.round(offset * 1.5));
  let y = 0;
  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    const ease =
      progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    x = Math.round(offset * ease);
    y += Math.round((Math.random() - 0.5) * 3);
    t += 8 + Math.round(Math.random() * 6);
    track.push([x, y, t]);
  }
  // 末尾停留若干点模拟松手
  for (let i = 0; i < 4; i++) {
    t += 60 + Math.round(Math.random() * 40);
    track.push([offset, y, t]);
  }
  return track;
}

/** 构造 slide 提交的 w = AES(JSON(slidePayload), sessionAesKey) + RSA(sessionAesKey)。
 *  sessionAesKey 是 fullpage/ajax/slide 共用的会话级客户端密钥；slideSecurityCode
 *  与 trajectoryCipherParameters 则来自 slide get.php，只用于 aa 轨迹二次加密。 */
function buildSlideW(
  geetestId: string,
  slideChallenge: string,
  sessionAesKey: string,
  slideOffset: number,
  trajectory: readonly GeetestTrajectoryPoint[],
  trajectoryCipherParameters: TrajectoryCipherParameters,
  slideSecurityCode: string,
): string {
  const geetestJs = getGeetestV3Js();
  const passtime = trajectory[trajectory.length - 1]![2]!;
  const encodedTrajectory = encodeTrajectory(trajectory);
  const encryptedTrajectory = encryptTrajectory(
    encodedTrajectory,
    trajectoryCipherParameters,
    slideSecurityCode,
  );
  const performanceTiming = generatePerformanceTiming();
  const slidePayload = {
    lang: "zh-cn",
    userresponse: geetestJs.getUserResponse(slideOffset, slideChallenge),
    passtime,
    imgload: 50,
    aa: encryptedTrajectory,
    ep: {
      v: "7.9.3",
      ["$_BIT"]: false,
      me: true,
      tm: performanceTiming,
      td: -1,
    },
    h9s9: "1816378497",
    rp: geetestJs.lmWn(
      geetestId + slideChallenge.slice(0, 32) + String(passtime),
    ),
  };
  return (
    geetestJs.aesEncrypt(JSON.stringify(slidePayload), sessionAesKey) +
    geetestJs.getA(sessionAesKey)
  );
}

/** 设备指纹 i 串模板（移植自 encrypt.js:1384 样本）。
 *  仅 UA、时间戳、随机尾段动态替换，其余硬件/语言/canvas 子段保持自洽。 */
function buildFingerprint(js: GeetestV3Js, ua: string): string {
  const ts = Date.now();
  const st = js.makeAeskey().slice(0, 6); // 6 位随机 hex
  const seg = [
    "5498",
    "15079",
    "CSS1Compat",
    "3",
    "-1",
    "-1",
    "-1",
    "-1",
    "-1",
    "-1",
    "-1",
    "1",
    "3",
    "9",
    "3",
    "2",
    "-1",
    "-1",
    "-1",
    "-1",
    "-1",
    "-1",
    "-1",
    "-1",
    "1",
    "1",
    "-1",
    "-1",
    "-1",
    "0",
    "0",
    "0",
    "0",
    "150",
    "937",
    "1920",
    "1040",
    "zh-CN",
    "zh-CN,zh",
    "-1",
    "1",
    "24",
    ua,
    "1",
    "1",
    "1920",
    "1080",
    "1920",
    "1040",
    "1",
    "1",
    "1",
    "-1",
    "Win32",
    "0",
    "-8",
    "71948b499cc30bdf612cc78c1f26b319",
    "04de6db98e1f861edab7ec1bdfb800bf",
    "",
    "0",
    "-1",
    "0",
    "4",
    "",
    `${ts}`,
    "-1,-1,0,0,0,0,0,22,9,4,8,8,15,438,438,446,-1,-1,-1,-1",
    "-1",
    "-1",
    "33",
    "-1",
    "1",
    "71",
    "17",
    "false",
    "false",
    st,
  ];
  return seg.join("!!");
}

/** 构造第 3 步 fullpage-w = aesEncrypt(JSON(eHWD)) + getA(aeskey)。
 *  eHWD 是配置态探测包（含指纹 i），aeskey 为会话级客户端密钥，
 *  RSA 尾段让服务端解出 aeskey 再 AES 解 body。 */
function buildFullpageW(
  js: GeetestV3Js,
  gt: string,
  challenge: string,
  aeskey: string,
  ua: string,
): string {
  const eHWD = {
    gt,
    challenge,
    offline: false,
    product: "popup",
    width: "100%",
    api_server: API_SERVER,
    https: true,
    protocol: "https://",
    static_servers: ["static.geetest.com"],
    aspect_radio: { slide: 103, click: 128 },
    type: "fullpage",
    cc: 4,
    ww: true,
    i: buildFingerprint(js, ua),
  };
  return js.aesEncrypt(JSON.stringify(eHWD), aeskey) + js.getA(aeskey);
}

/** 构造第 4 步 ajax-w = aesEncrypt(JSON(u))（**无 RSA 尾段**）。
 *  服务端已由 init 阶段 RSA 解出并按 gt+challenge 缓存会话 aeskey，
 *  故 ajax 不重发 RSA；多挂尾段会破坏 AES 块对齐致 error_03。
 *  字段编码非对称：i 单层 PwRX；hi/hh/rp 单层 PwRX；h/s 双层 PwRX；e 单层 PwRX(JSON)。 */
function buildAjaxW(
  js: GeetestV3Js,
  gt: string,
  challenge: string,
  aeskey: string,
  ua: string,
  iStr: string,
): string {
  const passtime = 1500 + Math.floor(Math.random() * 1500);
  const pw = (x: string) => js.pwrx(x);
  const u = {
    lang: "zh-cn",
    type: "fullpage",
    t: -1,
    light: -1,
    s: pw(pw("")),
    h: pw(pw("")),
    hh: pw(""),
    i: pw(iStr),
    hi: pw(""),
    vip_order: -1,
    ua,
    ct: -1,
    passtime,
    reservedParam: null,
    jType: "ajax",
    rp: pw(gt + challenge + String(passtime)),
    e: pw("{}"),
  };
  return js.aesEncrypt(JSON.stringify(u), aeskey);
}

export interface V3SolveResult {
  /** 最终用于提交 NatFrp 的 challenge（第二次 get.php 返回的更新值） */
  challenge: string;
  /** 极验 ajax.php step2 返回的 validate */
  validate: string;
  /** jordan 形式 seccode：validate + |jordan */
  seccode: string;
}

/**
 * 完整解算极验 3 滑块，返回可直接回传 NatFrp sign 的三件套。
 *
 * @param gt NatFrp 下发的极验 gt。
 * @param challenge NatFrp 下发的初始 challenge。
 * @param referer 站点来源页（NatFrp 用户中心），用于极验请求头与脚本分发。
 */
export async function solveGeetestV3(
  gt: string,
  challenge: string,
  referer = "https://www.natfrp.com/user/",
): Promise<V3SolveResult> {
  const client = createClient(referer);
  const baseParams = { gt, challenge, lang: "zh-cn" };
  const js = getGeetestV3Js();
  const ua = BROWSER_UA;
  // 会话级 aeskey：init 与 ajax step1 共用，服务端据 init 的 RSA 尾段解出并缓存。
  const aeskey = js.makeAeskey();
  const iStr = buildFingerprint(js, ua);

  // ---- 第一次 get.php（带 fullpage-w）：取初始 s/c/api_server，推进会话 ----
  // 真实浏览器此步带 pt=0/client_type=web/w=fullpageW；不带 w 则后续 slide 不出图。
  const loadParams = {
    ...baseParams,
    pt: "0",
    client_type: "web",
    w: buildFullpageW(js, gt, challenge, aeskey, ua),
    callback: `geetest_${nowTimestamp()}`,
  };
  const loadResp = await client.get(`https://${API_SERVER}/get.php`, {
    params: loadParams,
  });
  const loadData = parsePayload(loadResp.data);
  if (loadData.status && loadData.status !== "success") {
    throw new Error(
      `极验首次 get.php 状态异常: ${loadData.status} | resp=${describeResp(loadData)}`,
    );
  }
  // init 下发后续 slide 取图的主机（真实浏览器改打该 api_server）。
  const slideServer = loadData.data?.api_server ?? loadData.api_server ?? "";
  const slideHost = slideServer || API_SERVER;

  // ---- 第一次 ajax.php (step1，带 ajax-w)：推进会话至 slide 阶段 ----
  // 必须带 w 且**无 RSA 尾段**（服务端已缓存会话 aeskey）；返回 data.result==="slide"。
  const ajax1Resp = await client.get(`https://${slideHost}/ajax.php`, {
    params: {
      ...baseParams,
      pt: "0",
      client_type: "web",
      w: buildAjaxW(js, gt, challenge, aeskey, ua, iStr),
      callback: `geetest_${nowTimestamp()}`,
    },
  });
  const ajax1Data = parsePayload(ajax1Resp.data);
  if (ajax1Data.status && ajax1Data.status !== "success") {
    throw new Error(
      `极验 ajax step1 状态异常: ${ajax1Data.status} | resp=${describeResp(ajax1Data)}`,
    );
  }

  // ---- 第二次 get.php (is_next=slide3)：取缺口图 + 新 gt/challenge/s ----
  // 真实浏览器对 slide 取图改打下发的 api_server（多为 api.geevisit.com），
  // 且参数与抓包一致：https=false、protocol=https://、isPC、autoReset。
  const slideParams = {
    ...baseParams,
    is_next: "true",
    type: "slide3",
    https: "false",
    protocol: "https://",
    offline: "false",
    product: "embed",
    api_server: slideHost,
    isPC: "true",
    autoReset: "true",
    width: "100%",
    callback: `geetest_${nowTimestamp()}`,
  };
  const slideResp = await client.get(`https://${slideHost}/get.php`, {
    params: slideParams,
  });
  const slideData = parsePayload(slideResp.data);
  if (slideData.status && slideData.status !== "success") {
    throw new Error(
      `极验 slide get.php 状态异常: ${slideData.status} | resp=${describeResp(slideData)}`,
    );
  }
  // 出图响应为顶层平铺（非 data 子层）：图片、challenge、c、s 均优先取顶层。
  const slideConfig = slideData.data ?? {};
  const slideChallenge = slideData.challenge ?? slideConfig.challenge ?? challenge;
  const slideSecurityCode = slideData.s ?? slideConfig.s ?? "";
  const trajectoryCipherParameters = slideData.c ?? slideConfig.c ?? [];
  const gapImagePath =
    slideData.bg ?? slideConfig.bg ?? slideConfig.slice ?? slideData.slice ?? "";
  const fullBackgroundImagePath = slideData.fullbg ?? slideConfig.fullbg ?? "";
  if (!gapImagePath || !fullBackgroundImagePath) {
    throw new Error("极验 slide get.php 未返回缺口图地址");
  }
  if (!slideSecurityCode || trajectoryCipherParameters.length < 5) {
    throw new Error(
      `极验 slide get.php 未返回完整轨迹加密参数 | resp=${describeResp(slideData)}`,
    );
  }

  // 下载带缺口图与不带缺口图（static 服务器）。
  // slide 出图响应的 static_servers 指明图床（static.geevisit.com /
  // static.geetest.com），图片走这里——直接打 api.geevisit.com 会 403。
  // 优先用响应下发的 static_servers[0]（去尾斜杠），否则回退 slideHost。
  const staticServer = (
    slideData.static_servers?.[0] ??
    slideConfig.static_servers?.[0] ??
    STATIC_SERVER
  ).replace(/\/$/, "");
  const buildImageUrl = (path: string) =>
    path.startsWith("http")
      ? path
      : `https://${staticServer}/${path.replace(/^\//, "")}`;
  const imgClient = createClient(referer);
  imgClient.defaults.headers.common["Accept"] = "image/*,*/*;q=0.8";

  const gapBackgroundBytes = (
    await imgClient.get(buildImageUrl(gapImagePath), {
      responseType: "arraybuffer",
    })
  ).data as ArrayBuffer;
  const fullBackgroundBytes = (
    await imgClient.get(buildImageUrl(fullBackgroundImagePath), {
      responseType: "arraybuffer",
    })
  ).data as ArrayBuffer;

  // ---- 缺口识别 ----
  const { offset: slideOffset } = await calculateV3Offset(
    Buffer.from(gapBackgroundBytes),
    Buffer.from(fullBackgroundBytes),
  );

  // ---- 轨迹生成 + slide 加密 ----
  const trajectory = buildTrack(slideOffset);
  const w = buildSlideW(
    gt,
    slideChallenge,
    aeskey,
    slideOffset,
    trajectory,
    trajectoryCipherParameters,
    slideSecurityCode,
  );

  // ---- 第二次 ajax.php (step2)：提交 w 拿 validate ----
  // step2 与 slide 取图走同一 api_server（真实抓包验证提交亦在 geevisit）。
  // 真实抓包 step5 query：gt/challenge/lang/$_BCm=0/client_type=web/w/callback。
  // $_BCm 是 fullpage/multilink 会话绑定参数，缺则服务端 error_03。
  const verifyData2 = await client.get(`https://${slideHost}/ajax.php`, {
    params: {
      gt,
      challenge: slideChallenge,
      lang: "zh-cn",
      $_BCm: "0",
      client_type: "web",
      w,
      callback: `geetest_${nowTimestamp()}`,
    },
  });
  const verifyResult = parsePayload(verifyData2.data);
  if (verifyResult.status && verifyResult.status !== "success") {
    throw new Error(
      `极验校验状态非 success: ${verifyResult.status} | resp=${describeResp(verifyResult)}`,
    );
  }
  const validate = verifyResult.data?.validate ?? "";
  if (!validate)
    throw new Error(
      `极验 ajax.php 未返回 validate | resp=${describeResp(verifyResult)}`,
    );
  const seccode = `${validate}|jordan`;

  return { challenge: slideChallenge, validate, seccode };
}
