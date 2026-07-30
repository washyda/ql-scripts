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
import { getGeetestV3Js, type GeetestV3Js } from "./v3_js";

const API_SERVER = "api.geetest.com";
const STATIC_SERVER = "static.geetest.com";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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
function buildTrack(offset: number): number[][] {
  const track: number[][] = [
    [-32, -26, 0],
    [0, 0, 0],
  ];
  let x = 0;
  let t = 90;
  // 起步加速、中段匀速、末段减速
  const steps = Math.max(20, Math.round(offset * 1.5));
  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    // ease-in-out 风格位移
    const ease =
      progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    x = Math.round(offset * ease);
    t += 8 + Math.round(Math.random() * 6);
    track.push([x, 0, t]);
  }
  // 末尾停留若干点模拟松手
  for (let i = 0; i < 4; i++) {
    t += 60 + Math.round(Math.random() * 40);
    track.push([offset, 0, t]);
  }
  return track;
}

/** 构造 slide 提交的 w = encryptU(u, s) + getA(s)。 */
function buildSlideW(
  gt: string,
  challenge: string,
  s: string,
  offset: number,
  track: number[][],
): string {
  const js = getGeetestV3Js();
  const passtime = track[track.length - 1]![2]!;
  const u = {
    lang: "zh-cn",
    userresponse: js.getUserResponse(offset - 1, challenge),
    passtime,
    imgload: 150 + Math.round(Math.random() * 70),
    a: js.mouseEncrypt(track),
    ep: { v: "7.8.6", f: js.lmWn(gt + challenge) },
    rp: js.lmWn(gt + challenge.slice(0, 32) + String(passtime)),
  };
  return js.encryptU(u as unknown as Record<string, unknown>, s) + js.getA(s);
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
    throw new Error(`极验首次 get.php 状态异常: ${loadData.status}`);
  }
  let s = loadData.data?.s ?? loadData.s ?? "";
  if (!s) throw new Error("极验首次 get.php 未返回 s");
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
    throw new Error(`极验 ajax step1 状态异常: ${ajax1Data.status}`);
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
    throw new Error(`极验 slide get.php 状态异常: ${slideData.status}`);
  }
  // 出图响应为顶层平铺（非 data 子层）：bg/fullbg/slice/challenge/s 均优先取顶层。
  const sd = slideData.data ?? {};
  const newChallenge = slideData.challenge ?? sd.challenge ?? challenge;
  s = slideData.s ?? sd.s ?? s; // 用第二次 get.php 的新 s
  const bgPath = slideData.bg ?? sd.bg ?? sd.slice ?? slideData.slice ?? "";
  const fullbgPath = slideData.fullbg ?? sd.fullbg ?? "";
  if (!bgPath || !fullbgPath) {
    throw new Error("极验 slide get.php 未返回缺口图地址");
  }

  // 下载带缺口图与不带缺口图（static 服务器）。
  // slide 出图响应的 static_servers 指明图床（static.geevisit.com /
  // static.geetest.com），图片走这里——直接打 api.geevisit.com 会 403。
  // 优先用响应下发的 static_servers[0]（去尾斜杠），否则回退 slideHost。
  const staticServer = (
    slideData.static_servers?.[0] ??
    sd.static_servers?.[0] ??
    STATIC_SERVER
  ).replace(/\/$/, "");
  const buildImageUrl = (path: string) =>
    path.startsWith("http")
      ? path
      : `https://${staticServer}/${path.replace(/^\//, "")}`;
  const imgClient = createClient(referer);
  imgClient.defaults.headers.common["Accept"] = "image/*,*/*;q=0.8";

  const gapBytes = (
    await imgClient.get(buildImageUrl(bgPath), { responseType: "arraybuffer" })
  ).data as ArrayBuffer;
  const fullBytes = (
    await imgClient.get(buildImageUrl(fullbgPath), {
      responseType: "arraybuffer",
    })
  ).data as ArrayBuffer;

  // ---- 缺口识别 ----
  const { offset } = await calculateV3Offset(
    Buffer.from(gapBytes),
    Buffer.from(fullBytes),
  );

  // ---- 轨迹生成 + slide 加密 ----
  const track = buildTrack(offset);
  const w = buildSlideW(gt, newChallenge, s, offset, track);

  // ---- 第二次 ajax.php (step2)：提交 w 拿 validate ----
  // step2 与 slide 取图走同一 api_server（真实抓包验证提交亦在 geevisit）。
  const verifyData2 = await client.get(`https://${slideHost}/ajax.php`, {
    params: {
      gt,
      challenge: newChallenge,
      lang: "zh-cn",
      w,
      callback: `geetest_${nowTimestamp()}`,
    },
  });
  const verifyResult = parsePayload(verifyData2.data);
  if (verifyResult.status && verifyResult.status !== "success") {
    throw new Error(`极验校验状态非 success: ${verifyResult.status}`);
  }
  const validate = verifyResult.data?.validate ?? "";
  if (!validate) throw new Error("极验 ajax.php 未返回 validate");
  const seccode = `${validate}|jordan`;

  return { challenge: newChallenge, validate, seccode };
}
