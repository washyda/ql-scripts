/**
 * 极验 v4 滑块验证码aigis解算。
 *
 * 移植自 cloudgame_checkin 的 main.cpp::geetest 命名空间。
 * 链路：米哈游登录触发 aigis（x-rpc-aigis 含 session_id + captcha_id）
 * → gcaptcha4.geetest.com /load 取缺口图与 PoW 参数
 * → 移植的缺口识别算 setLeft
 * → generate_w 构造 w（PoW + userresponse + AES-256-CBC + RSA-1024 加密）
 * → /verify 提交拿 seccode，拼成可重放登录的 aigis token。
 *
 * 全部用 Node 内置 crypto，无外部 JS 执行。
 */
import crypto from "node:crypto";
import axios, { type AxiosInstance } from "axios";
import { estimateOffsetFromBytes } from "./offset_estimator";

const GT_RSA_N_HEX =
  "00C1E3934D1614465B33053E7F48EE4EC87B14B95EF88947713D25EECBFF7E74C7" +
  "977D02DC1D9451F79DD5D1C10C29ACB6A9B4D6FB7D0A0279B6719E1772565F09AF" +
  "627715919221AEF91899CAE08C0D686D748B20A3603BE2318CA6BC2B59706592A9" +
  "219D0BF05C9F65023A21D2330807252AE0066D59CEEFA5F2748EA80BAB81";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0";

const GT_REFERER = "https://user.mihoyo.com/";

/** 极验 v4 RSA-1024 公钥（PKCS1，PKCS1Padding）。 */
function gtRsaEncryptHex(plaintext: string): string {
  const nBytes = Buffer.from(GT_RSA_N_HEX.replace(/^00/, ""), "hex");
  const key = crypto.createPublicKey({
    key: {
      kty: "RSA",
      n: nBytes.toString("base64url"),
      e: "AQAD", // 0x10001
    },
    format: "jwk",
  });
  const encrypted = crypto.publicEncrypt(
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(plaintext, "utf8"),
  );
  return encrypted.toString("hex");
}

function hashHex(func: "md5" | "sha1", data: string): string {
  return crypto.createHash(func).update(data).digest("hex");
}

function newUuidV4(): string {
  return crypto.randomUUID();
}

/** AES-256-CBC 加密，零 IV，明文做 PKCS7 填充，输出 hex。 */
function aesCbcEncryptHex(plaintext: string, key: string): string {
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(key, "utf8"),
    iv,
  );
  cipher.setAutoPadding(false);
  const block = 16;
  const padLen = block - (Buffer.byteLength(plaintext, "utf8") % block);
  const padded = plaintext + String.fromCharCode(padLen).repeat(padLen);
  let out = cipher.update(Buffer.from(padded, "utf8"));
  out = Buffer.concat([out, cipher.final()]);
  return out.toString("hex");
}

interface PowDetail {
  version?: string;
  hashfunc?: string;
  bits?: number | string;
  datetime?: string;
}

interface PowResult {
  powMsg: string;
  powSign: string;
}

/** 极验工作量证明。 */
export function proofOfWork(
  lotNumber: string,
  captchaId: string,
  version: string,
  hashfunc: "md5" | "sha1",
  bits: number,
  datetimeStr: string,
): PowResult {
  if (bits === 0) {
    const h = newUuidV4().replaceAll("-", "");
    const powMsg = `${version}|${bits}|${hashfunc}|${datetimeStr}|${captchaId}|${lotNumber}||${h}`;
    const powSign = hashHex(hashfunc, powMsg);
    return { powMsg, powSign };
  }

  const a = bits % 4;
  const b = Math.floor(bits / 4);
  const u = "0".repeat(b);
  const prefix = `${version}|${bits}|${hashfunc}|${datetimeStr}|${captchaId}|${lotNumber}||`;
  const threshold = [0, 7, 3, 1];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const h = newUuidV4().replaceAll("-", "");
    const powMsg = prefix + h;
    const powSign = hashHex(hashfunc, powMsg);
    if (a === 0) {
      if (powSign.slice(0, b) === u) return { powMsg, powSign };
    } else if (powSign.length > b && powSign.slice(0, b) === u) {
      const d = parseInt(powSign.slice(b, b + 1), 16);
      if (d <= threshold[a]!) return { powMsg, powSign };
    }
  }
}

function scalarString(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return fallback;
}

function calculateUserResponse(setLeft: number, imgWidth: number): number {
  return setLeft / ((0.8876 * 340.0) / imgWidth) + 2.0;
}

interface GenerateWInput {
  setLeft: number;
  passTime: number;
  lotNumber: string;
  powDetail: PowDetail;
  captchaId: string;
  imgWidth: number;
}

/** 构造极验 v4 滑块提交参数 w = aes(h(params)) + aesKey 的 RSA 密文 hex。 */
export function generateW(input: GenerateWInput): string {
  const { setLeft, passTime, lotNumber, powDetail, captchaId, imgWidth } =
    input;
  const version = powDetail.version ?? "1";
  const hashfunc = (powDetail.hashfunc ?? "md5") as "md5" | "sha1";
  const bits = parseInt(scalarString(powDetail.bits, "0"), 10) || 0;
  const dt = powDetail.datetime ?? "";

  const powRes = proofOfWork(lotNumber, captchaId, version, hashfunc, bits, dt);

  const params: Record<string, unknown> = {
    setLeft,
    passtime: passTime,
    userresponse: calculateUserResponse(setLeft, imgWidth),
    device_id: "",
    lot_number: lotNumber,
    pow_msg: powRes.powMsg,
    pow_sign: powRes.powSign,
    geetest: "captcha",
    lang: "zh",
    ep: "123",
    biht: "1426265548",
    em: { ph: 0, cp: 0, ek: "11", wd: 1, nt: 0, si: 0, sc: 0 },
  };

  if (lotNumber.length >= 28) {
    const key = lotNumber.slice(1, 5);
    const val = lotNumber.slice(24, 28);
    params[key] = val;
  }

  const paramsJson = JSON.stringify(params);
  const aesKey = newUuidV4().replaceAll("-", "");
  const rsaEncKey = gtRsaEncryptHex(aesKey);
  const aesEnc = aesCbcEncryptHex(paramsJson, aesKey);
  return aesEnc + rsaEncKey;
}

/** 从 JSONP 文本（callback(...)）提取内部 JSON。 */
function extractJsonp(text: string, callback: string): unknown {
  let jsonStr = text.trim();
  if (jsonStr.startsWith(callback)) {
    jsonStr = jsonStr.slice(callback.length).trim();
    if (jsonStr.startsWith("(")) jsonStr = jsonStr.slice(1);
    if (jsonStr.endsWith(")")) jsonStr = jsonStr.slice(0, -1);
  }
  return JSON.parse(jsonStr);
}

function createGeetestClient(): AxiosInstance {
  return axios.create({
    timeout: 20_000,
    headers: {
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      Connection: "keep-alive",
      Referer: GT_REFERER,
      "Sec-Fetch-Dest": "script",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": "cross-site",
      "User-Agent": BROWSER_UA,
    },
  });
}

function createImageClient(): AxiosInstance {
  return axios.create({
    timeout: 20_000,
    responseType: "arraybuffer",
    headers: {
      Accept:
        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9",
      Connection: "keep-alive",
      Referer: GT_REFERER,
      "Sec-Fetch-Dest": "image",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": "cross-site",
      "User-Agent": BROWSER_UA,
    },
  });
}

interface AigisInner {
  session_id: string;
  captcha_id: string;
  risk_type: string;
}

/** 解析 x-rpc-aigis 报头（JSON），返回 session_id / captcha_id / risk_type。 */
export function parseAigis(aigisRaw: string): AigisInner {
  const aigis = JSON.parse(aigisRaw) as {
    session_id?: string;
    data?: string;
  };
  const sessionId = aigis.session_id ?? "";
  const inner = JSON.parse(aigis.data ?? "{}") as {
    gt?: string;
    risk_type?: string;
  };
  const captchaId = inner.gt ?? "";
  if (!captchaId) throw new Error("aigis captcha_id 为空");
  return {
    session_id: sessionId,
    captcha_id: captchaId,
    risk_type: inner.risk_type ?? "slide",
  };
}

interface GeetestLoadData {
  lot_number: string;
  slice: string;
  bg: string;
  pow_detail: PowDetail;
  payload: string;
  process_token: string;
  payload_protocol: string | number;
  pt: string | number;
  captcha_type?: string;
}

interface LoadResult {
  data: GeetestLoadData;
  captchaType: string;
}

async function geetestLoad(
  client: AxiosInstance,
  params: AigisInner,
): Promise<LoadResult> {
  const timestamp = Date.now().toString();
  const callback = `geetest_${timestamp}`;
  const challenge = newUuidV4();
  const userInfo = JSON.stringify({ session_id: params.session_id });
  const url =
    `https://gcaptcha4.geetest.com/load?callback=${encodeURIComponent(callback)}` +
    `&captcha_id=${encodeURIComponent(params.captcha_id)}` +
    `&challenge=${encodeURIComponent(challenge)}` +
    `&client_type=web&risk_type=${encodeURIComponent(params.risk_type)}` +
    `&user_info=${encodeURIComponent(userInfo)}&lang=zho`;

  const res = await client.get(url);
  const parsed = extractJsonp(res.data as string, callback) as {
    status: string;
    data: GeetestLoadData;
  };
  if (parsed.status !== "success") {
    throw new Error(`geetest /load 状态非 success: ${parsed.status}`);
  }
  return {
    data: parsed.data,
    captchaType: parsed.data.captcha_type ?? params.risk_type,
  };
}

async function geetestVerify(
  client: AxiosInstance,
  args: {
    callback: string;
    captchaId: string;
    lotNumber: string;
    riskType: string;
    payload: string;
    processToken: string;
    payloadProtocol: string;
    pt: string;
    w: string;
  },
): Promise<{ result: string; seccode: Record<string, string> }> {
  const url =
    `https://gcaptcha4.geetest.com/verify?callback=${encodeURIComponent(args.callback)}` +
    `&captcha_id=${encodeURIComponent(args.captchaId)}` +
    `&client_type=web` +
    `&lot_number=${encodeURIComponent(args.lotNumber)}` +
    `&risk_type=${encodeURIComponent(args.riskType)}` +
    `&payload=${encodeURIComponent(args.payload)}` +
    `&process_token=${encodeURIComponent(args.processToken)}` +
    `&payload_protocol=${encodeURIComponent(args.payloadProtocol)}` +
    `&pt=${encodeURIComponent(args.pt)}` +
    `&w=${encodeURIComponent(args.w)}`;

  const res = await client.get(url);
  const parsed = extractJsonp(res.data as string, args.callback) as {
    status: string;
    data: { result: string; seccode: Record<string, string> };
  };
  return { result: parsed.data.result, seccode: parsed.data.seccode };
}

/**
 * 完整解算米哈游 aigis 滑块，返回可直接用于 x-rpc-aigis 报头的 token。
 * 格式：`session_id;base64(seccode_json)`，其中 seccode_json 含 lot_number/captcha_id/pass_token/gen_time/captcha_output/userInfo。
 *
 * @param aigisRaw 登录响应里的 x-rpc-aigis 报头原始值。
 */
export async function solveAigisCaptcha(aigisRaw: string): Promise<string> {
  const params = parseAigis(aigisRaw);
  const client = createGeetestClient();

  const { data: gtData, captchaType } = await geetestLoad(client, params);

  const imgClient = createImageClient();
  const downloadImage = async (path: string): Promise<Buffer> => {
    const urlPath = path.startsWith("/") ? path : `/${path}`;
    const res = await imgClient.get(`https://static.geetest.com${urlPath}`);
    return Buffer.from(res.data as ArrayBuffer);
  };

  const sliceBytes = await downloadImage(gtData.slice);
  const bgBytes = await downloadImage(gtData.bg);

  const offset = estimateOffsetFromBytes(sliceBytes, bgBytes);
  const setLeft = Math.round(offset.horizontalOffset);
  const imgWidth = offset.imageWidth;

  const passTime =
    1800 + Math.floor(Math.random() * 600) + Math.floor(Math.random() * 200);
  await new Promise((resolve) => setTimeout(resolve, passTime));

  const w = generateW({
    setLeft,
    passTime,
    lotNumber: gtData.lot_number,
    powDetail: gtData.pow_detail,
    captchaId: params.captcha_id,
    imgWidth,
  });

  const callback = `geetest_${Date.now().toString()}`;
  const verify = await geetestVerify(client, {
    callback,
    captchaId: params.captcha_id,
    lotNumber: gtData.lot_number,
    riskType: captchaType,
    payload: gtData.payload,
    processToken: gtData.process_token,
    payloadProtocol: scalarString(gtData.payload_protocol, "1"),
    pt: scalarString(gtData.pt, "1"),
    w,
  });

  if (verify.result !== "success") {
    throw new Error(`geetest /verify 未通过: result=${verify.result}`);
  }

  const aigisData = {
    lot_number: gtData.lot_number,
    captcha_id: params.captcha_id,
    pass_token: verify.seccode.pass_token ?? "",
    gen_time: verify.seccode.gen_time ?? "",
    captcha_output: verify.seccode.captcha_output ?? "",
    userInfo: JSON.stringify({ session_id: params.session_id }),
  };
  const aigisB64 = Buffer.from(JSON.stringify(aigisData), "utf8").toString(
    "base64",
  );
  return `${params.session_id};${aigisB64}`;
}
