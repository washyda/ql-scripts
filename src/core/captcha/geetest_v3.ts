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

// The legacy V3 fullpage bootstrap used by NatFrp is served from apiv6.  The
// slide phase itself is redirected to api.geevisit.com by the response.
const API_SERVER = "apiv6.geetest.com";
const STATIC_SERVER = "static.geetest.com";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

interface SlidePerformanceTiming {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  g: number;
  h: number;
  i: number;
  j: number;
  k: number;
  l: number;
  m: number;
  n: number;
  o: number;
  p: number;
  q: number;
  r: number;
  s: number;
  t: number;
  u: number;
}

function generatePerformanceTiming(
  baseTimestamp = Date.now(),
): SlidePerformanceTiming {
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
    a: baseTimestamp,
    b: unloadEventStart,
    c: unloadEventEnd,
    d: 0,
    e: 0,
    f: fetchStart,
    g: domainLookupStart,
    h: domainLookupEnd,
    i: connectStart,
    j: connectEnd,
    k: secureConnectionStart,
    l: requestStart,
    m: responseStart,
    n: responseEnd,
    o: domLoading,
    p: domInteractive,
    q: domContentLoadedEventStart,
    r: domContentLoadedEventEnd,
    s: domComplete,
    t: loadEventStart,
    u: loadEventEnd,
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
  // 错误载体：极验 slide 失败常返回 success/message，而不是 status/data。
  success?: number | boolean;
  message?: string;
  msg?: string;
  error_code?: string | number;
  desc?: string;
}

/** 把极验响应体压成可读字符串，保留顶层 success/message 便于定位 fail/forbidden。 */
function describeResp(r: GeetestResponseData): string {
  return JSON.stringify({
    status: r.status,
    success: r.success,
    message: r.message,
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

/** Minimal per-solve cookie jar. Axios in Node does not retain Set-Cookie
 * between requests, unlike a browser or Python requests.Session. */
class GeetestCookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(setCookie: string | string[] | undefined): void {
    const lines = Array.isArray(setCookie)
      ? setCookie
      : setCookie
        ? [setCookie]
        : [];
    for (const line of lines) {
      const pair = line.split(";", 1)[0];
      const separator = pair?.indexOf("=") ?? -1;
      if (separator <= 0) continue;
      const name = pair!.slice(0, separator).trim();
      const value = pair!.slice(separator + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

function createClient(
  referer: string,
  cookieJar?: GeetestCookieJar,
): AxiosInstance {
  const client = axios.create({
    timeout: 20_000,
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      Referer: referer,
      Origin: new URL(referer).origin,
    },
  });
  if (!cookieJar) return client;
  client.interceptors.request.use((config) => {
    const cookie = cookieJar.header();
    if (cookie) config.headers.set("Cookie", cookie);
    return config;
  });
  client.interceptors.response.use((response) => {
    cookieJar.absorb(response.headers["set-cookie"]);
    return response;
  });
  return client;
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
export function buildTrack(
  slideOffset: number,
  random: () => number = Math.random,
): GeetestTrajectoryPoint[] {
  const randomInt = (minimum: number, maximum: number) =>
    minimum + Math.floor(random() * (maximum - minimum + 1));
  const trajectory: GeetestTrajectoryPoint[] = [
    [randomInt(-50, -10), randomInt(-50, -10), 0],
    [0, 0, 0],
  ];
  const pointCount = 10 + Math.floor(slideOffset / 2);
  let elapsedTime = randomInt(50, 100);
  let previousX = 0;

  for (let index = 0; index < pointCount; index++) {
    const progress = index / pointCount;
    const x = Math.round(
      (progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress)) * slideOffset,
    );
    elapsedTime += randomInt(10, 50);
    if (x === previousX) continue;
    trajectory.push([x, 0, elapsedTime]);
    previousX = x;
  }
  // Python 参考实现会原样追加末点；该零时差会被轨迹压缩器忽略。
  trajectory.push(trajectory[trajectory.length - 1]!);
  return trajectory;
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
    new_captcha: true,
    product: "float",
    width: "300px",
    api_server: API_SERVER,
    https: true,
    protocol: "https://",
    static_servers: ["static.geetest.com/", "static.geevisit.com/"],
    voice: "/static/js/voice.1.2.6.js",
    click: "/static/js/click.3.1.2.js",
    beeline: "/static/js/beeline.1.0.1.js",
    fullpage: "/static/js/fullpage.9.2.0-guwyxh.js",
    slide: "/static/js/slide.7.9.3.js",
    geetest: "/static/js/geetest.6.0.9.js",
    aspect_radio: { slide: 103, click: 128, voice: 128, beeline: 50 },
    type: "fullpage",
    cc: 16,
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
  cipherParameters: TrajectoryCipherParameters,
  securityCode: string,
): string {
  const startX = 400 + Math.floor(Math.random() * 201);
  const startY = 400 + Math.floor(Math.random() * 101);
  const pointCount = 18;
  const trace: GeetestTrajectoryPoint[] = [[startX, startY, 0]];
  for (let index = 1; index <= pointCount; index++) {
    const progress = index / pointCount;
    trace.push([
      Math.round(startX + (853 - startX) * progress),
      Math.round(startY + (288 - startY) * progress),
      index * (45 + Math.floor(Math.random() * 20)),
    ]);
  }
  const passtime = trace[trace.length - 1]![2]!;
  const tt = encryptTrajectory(
    js.mouseEncrypt(trace),
    cipherParameters,
    securityCode,
  );
  const u = {
    lang: "zh-cn",
    type: "fullpage",
    tt,
    light: "DIV_0",
    s: "c7c3e21112fe4f741921cb3e4ff9f7cb",
    h: "321f9af1e098233dbd03f250fd2b5e21",
    hh: "39bd9cad9e425c3a8f51610fd506e3b3",
    hi: "09eb21b3ae9542a9bc1e8b63b3d9a467",
    vip_order: -1,
    ct: -1,
    ep: {
      v: "9.2.0-guwyxh",
      te: false,
      ["$_BBn"]: true,
      ven: "Google Inc. (AMD)",
      ren: "ANGLE (AMD, AMD Radeon RX 6750 GRE 12GB (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      fp: trace[0],
      lp: trace[trace.length - 1],
      em: { ph: 0, cp: 0, ek: "11", wd: 1, nt: 0, si: 0, sc: 0 },
      tm: generatePerformanceTiming(),
      dnf: "dnf",
      by: 0,
    },
    passtime,
    rp: js.lmWn(gt + challenge + String(passtime)),
    captcha_token: "112439067",
    tsfq: "xovrayel",
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
  const cookieJar = new GeetestCookieJar();
  const client = createClient(referer, cookieJar);
  const baseParams = { gt, challenge, lang: "zh-cn" };
  const js = getGeetestV3Js();
  const ua = BROWSER_UA;
  // 会话级 aeskey：init 与 ajax step1 共用，服务端据 init 的 RSA 尾段解出并缓存。
  const aeskey = js.makeAeskey();

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
  const fullpageCipherParameters = loadData.data?.c ?? loadData.c ?? [];
  const fullpageSecurityCode = loadData.data?.s ?? loadData.s ?? "";
  if (fullpageCipherParameters.length < 5 || fullpageSecurityCode.length < 2) {
    throw new Error("极验首次 get.php 未返回完整 fullpage 加密参数");
  }

  // ---- 第一次 ajax.php (step1，带 ajax-w)：推进会话至 slide 阶段 ----
  // 必须带 w 且**无 RSA 尾段**（服务端已缓存会话 aeskey）；返回 data.result==="slide"。
  const ajax1Resp = await client.get(`https://${slideHost}/ajax.php`, {
    params: {
      ...baseParams,
      pt: "0",
      client_type: "web",
      w: buildAjaxW(
        js,
        gt,
        challenge,
        aeskey,
        fullpageCipherParameters,
        fullpageSecurityCode,
      ),
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
  const slideChallenge =
    slideData.challenge ?? slideConfig.challenge ?? challenge;
  const slideSecurityCode = slideData.s ?? slideConfig.s ?? "";
  const trajectoryCipherParameters = slideData.c ?? slideConfig.c ?? [];
  const gapImagePath = slideData.bg ?? slideConfig.bg ?? "";
  const sliceImagePath = slideData.slice ?? slideConfig.slice ?? "";
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
  const imgClient = createClient(referer, cookieJar);
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
  const sliceBytes = sliceImagePath
    ? ((
        await imgClient.get(buildImageUrl(sliceImagePath), {
          responseType: "arraybuffer",
        })
      ).data as ArrayBuffer)
    : undefined;

  // ---- 缺口识别 ----
  const { offset: slideOffset } = await calculateV3Offset(
    Buffer.from(gapBackgroundBytes),
    Buffer.from(fullBackgroundBytes),
    sliceBytes ? Buffer.from(sliceBytes) : undefined,
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
  // V3 ajax success responses may be JSONP objects with validate at the top
  // level (NatFrp), while some deployments nest it under data.
  const validate = verifyResult.validate ?? verifyResult.data?.validate ?? "";
  if (!validate)
    throw new Error(
      `极验 ajax.php 未返回 validate | resp=${describeResp(verifyResult)}`,
    );
  const seccode = `${validate}|jordan`;

  return { challenge: slideChallenge, validate, seccode };
}
