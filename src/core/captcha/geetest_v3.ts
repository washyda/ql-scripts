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
import { getGeetestV3Js } from "./v3_js";

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
  };
  // 顶层也可能是平铺 s/c（get.php 旧格式）
  s?: string;
  c?: Array<number>;
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

  // ---- 第一次 get.php：取初始 s/c 与验证信息 ----
  const loadParams = {
    ...baseParams,
    callback: `geetest_${nowTimestamp()}`,
  };
  const loadResp = await client.get(`https://${API_SERVER}/get.php`, {
    params: loadParams,
  });
  const loadData = parsePayload(loadResp.data);
  // fullpage w 在官方标准 slide 链路里可省略，仅依赖服务端下发的 s
  let s = loadData.data?.s ?? loadData.s ?? "";
  if (!s) throw new Error("极验首次 get.php 未返回 s");

  // ---- 第一次 ajax.php (step1)：确认进入滑块阶段 ----
  const ajax1Resp = await client.get(`https://${API_SERVER}/ajax.php`, {
    params: { ...baseParams, callback: `geetest_${nowTimestamp()}` },
  });
  parsePayload(ajax1Resp.data); // step1 结果主要确认连通，字段忽略

  // ---- 第二次 get.php (is_next=slide3)：取缺口图 + 新 gt/challenge/s ----
  const slideParams = {
    ...baseParams,
    is_next: "true",
    type: "slide3",
    https: "true",
    protocol: "https://",
    offline: "false",
    product: "embed",
    api_server: API_SERVER,
    width: "100%",
    callback: `geetest_${nowTimestamp()}`,
  };
  const slideResp = await client.get(`https://${API_SERVER}/get.php`, {
    params: slideParams,
  });
  const slideData = parsePayload(slideResp.data);
  if (slideData.status && slideData.status !== "success") {
    throw new Error(`极验 slide get.php 状态异常: ${slideData.status}`);
  }
  // slide 数据可能在 data 子对象或顶层，统一读取
  const sd = slideData.data ?? {};
  const newChallenge = sd.challenge ?? challenge;
  s = sd.s ?? slideData.s ?? s; // 用第二次 get.php 的新 s
  const bgPath = sd.bg ?? sd.slice ?? "";
  const fullbgPath = sd.fullbg ?? "";
  if (!bgPath || !fullbgPath) {
    throw new Error("极验 slide get.php 未返回缺口图地址");
  }

  // 下载带缺口图与不带缺口图（static 服务器）
  const buildImageUrl = (path: string) =>
    path.startsWith("http")
      ? path
      : `https://${STATIC_SERVER}/${path.replace(/^\//, "")}`;
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
  const { offset } = calculateV3Offset(
    Buffer.from(gapBytes),
    Buffer.from(fullBytes),
  );

  // ---- 轨迹生成 + slide 加密 ----
  const track = buildTrack(offset);
  const w = buildSlideW(gt, newChallenge, s, offset, track);

  // ---- 第二次 ajax.php (step2)：提交 w 拿 validate ----
  const verifyData2 = await client.get(`https://${API_SERVER}/ajax.php`, {
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
