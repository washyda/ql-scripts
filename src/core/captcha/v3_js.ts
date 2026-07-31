/**
 * 极验 3 滑块 w 参数加密的 JS 执行桥。
 *
 * 移植自 geetest-crack 的 slide 加密链路：u_params.js（lmWn / getUserResponse /
 * mouse_encrypt）+ encrypt.js（_encrypt，即 slide_u）+ slide_a.js（get_a）。
 * 这三个文件是纯算法（RC4/RSA/MD5/轨迹编码），与平安域名无关，可直接用于
 * 官方 api.geetest.com 的 slide 提交。
 *
 * 关键修正：官方标准 3.x 接口下，w 的加密密钥 s 由 get.php 响应服务端下发，
 * 不能像平安版那样客户端 get_s() 自造。本桥只负责「给定 s，做加密」，
 * s 的来源由 geetest_v3.ts 协议层从 get.php /ajax.php 响应里取。
 */
import { randomBytes } from "node:crypto";
import { createContext, runInContext, type Context } from "node:vm";
import { U_PARAMS_JS, SLIDE_A_JS, ENCRYPT_JS } from "./v3_js_sources";

function loadScript(ctx: Context, code: string): void {
  runInContext(code, ctx);
}

let cache: GeetestV3Js | null = null;

type JsBindings = {
  lmWn: (data: string) => string;
  getUserResponse: (offset: number, challenge: string) => string;
  mouse_encrypt: (track: unknown) => string;
  _encrypt: (u: unknown, s: string) => string;
  get_a: (s: string) => string;
};

export type GeetestTrajectoryPoint = readonly [x: number, y: number, time: number];
export type TrajectoryCipherParameters = readonly number[];

const TRAJECTORY_CHARSET =
  "()*,-./0123456789:?@ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqr";
const TRAJECTORY_DIRECTION_CODES = "stuvwxyz~";
const TRAJECTORY_DIRECTION_PATTERNS: readonly (readonly [number, number])[] = [
  [1, 0],
  [2, 0],
  [1, -1],
  [1, 1],
  [0, 1],
  [0, -1],
  [3, 0],
  [2, -1],
  [2, 1],
];

function encodeTrajectoryNumber(value: number): string {
  const absoluteValue = Math.abs(value);
  const highDigit = Math.floor(absoluteValue / TRAJECTORY_CHARSET.length);
  let encoded = value < 0 ? "!" : "";
  if (highDigit > 0 && highDigit < TRAJECTORY_CHARSET.length) {
    encoded += `$${TRAJECTORY_CHARSET[highDigit]}`;
  }
  return encoded + TRAJECTORY_CHARSET[absoluteValue % TRAJECTORY_CHARSET.length];
}

function getTrajectoryDirectionCode(deltaX: number, deltaY: number): string | null {
  const directionIndex = TRAJECTORY_DIRECTION_PATTERNS.findIndex(
    ([patternX, patternY]) => patternX === deltaX && patternY === deltaY,
  );
  return directionIndex < 0
    ? null
    : TRAJECTORY_DIRECTION_CODES[directionIndex]!;
}

/** Encode cumulative [x, y, time] points into the slide `aa` preimage format. */
export function encodeTrajectory(
  trajectory: readonly GeetestTrajectoryPoint[],
): string {
  const compressedPoints: Array<[deltaX: number, deltaY: number, deltaTime: number]> = [];
  let accumulatedStationaryTime = 0;

  for (let pointIndex = 0; pointIndex + 1 < trajectory.length; pointIndex++) {
    const currentPoint = trajectory[pointIndex]!;
    const nextPoint = trajectory[pointIndex + 1]!;
    const deltaX = nextPoint[0] - currentPoint[0];
    const deltaY = nextPoint[1] - currentPoint[1];
    const deltaTime = Math.abs(nextPoint[2] - currentPoint[2]);

    if (deltaX === 0 && deltaY === 0 && deltaTime === 0) continue;
    if (deltaX === 0 && deltaY === 0) {
      accumulatedStationaryTime += deltaTime;
      continue;
    }

    compressedPoints.push([
      deltaX,
      deltaY,
      deltaTime + accumulatedStationaryTime,
    ]);
    accumulatedStationaryTime = 0;
  }

  if (accumulatedStationaryTime !== 0) {
    compressedPoints.push([0, 0, accumulatedStationaryTime]);
  }

  const encodedX: string[] = [];
  const encodedY: string[] = [];
  const encodedTime: string[] = [];
  for (const [deltaX, deltaY, deltaTime] of compressedPoints) {
    const directionCode = getTrajectoryDirectionCode(deltaX, deltaY);
    if (directionCode) {
      encodedY.push(directionCode);
    } else {
      encodedX.push(encodeTrajectoryNumber(deltaX));
      encodedY.push(encodeTrajectoryNumber(deltaY));
    }
    encodedTime.push(encodeTrajectoryNumber(deltaTime));
  }

  return `${encodedX.join("")}!!${encodedY.join("")}!!${encodedTime.join("")}`;
}

/** Apply the slide response c/s insertion transform to the encoded `aa` string. */
export function encryptTrajectory(
  encodedTrajectory: string,
  trajectoryCipherParameters: TrajectoryCipherParameters,
  slideSecurityCode: string,
): string {
  if (
    encodedTrajectory.length === 0 ||
    trajectoryCipherParameters.length < 5 ||
    slideSecurityCode.length < 2
  ) {
    return encodedTrajectory;
  }

  const [quadraticCoefficient, linearCoefficient, constantCoefficient] = [
    trajectoryCipherParameters[0]!,
    trajectoryCipherParameters[2]!,
    trajectoryCipherParameters[4]!,
  ];
  let encryptedTrajectory = encodedTrajectory;
  for (let index = 0; index + 1 < slideSecurityCode.length; index += 2) {
    const cipherByte = Number.parseInt(
      slideSecurityCode.slice(index, index + 2),
      16,
    );
    if (!Number.isFinite(cipherByte)) continue;
    const insertionPosition =
      (quadraticCoefficient * cipherByte * cipherByte +
        linearCoefficient * cipherByte +
        constantCoefficient) % encodedTrajectory.length;
    encryptedTrajectory =
      encryptedTrajectory.slice(0, insertionPosition) +
      String.fromCharCode(cipherByte) +
      encryptedTrajectory.slice(insertionPosition);
  }
  return encryptedTrajectory;
}

export class GeetestV3Js {
  private ctx: Context;

  constructor() {
    const ctx = createContext({
      console,
      window: {},
      navigator: { appName: "Netscape", appVersion: "5.0", platform: "Win32" },
      document: {},
      Math,
      Date,
      parseInt,
      String,
      Array,
      Object,
      JSON,
    });
    this.ctx = ctx;
    loadScript(ctx, U_PARAMS_JS);
    loadScript(ctx, ENCRYPT_JS);
    loadScript(ctx, SLIDE_A_JS);
  }

  private bind(): JsBindings {
    return this.ctx as unknown as JsBindings;
  }

  /** MD5 类运算，对应 u_params.js 中的 lmWn。 */
  lmWn(data: string): string {
    return this.bind().lmWn(data);
  }

  /** userresponse 换算。 */
  getUserResponse(offset: number, challenge: string): string {
    return this.bind().getUserResponse(offset, challenge);
  }

  /** 鼠标轨迹加密（a 字段）。 */
  mouseEncrypt(track: unknown): string {
    return this.bind().mouse_encrypt(track);
  }

  /** slide_u：对 u 对象用 s 做 RC4 加密。 */
  encryptU(u: Record<string, unknown>, s: string): string {
    return this.bind()._encrypt(u, s);
  }

  /** slide_a：生成 a 段（RSA 加密的随机数等）。 */
  getA(s: string): string {
    return this.bind().get_a(s);
  }

  /** 自定义字符串 base64 编码（encrypt.js 的 GxkI.PwRX）。 */
  pwrx(s: string): string {
    return this.ctx.GxkI.PwRX(s);
  }

  /** 生成会话级 16 hex aeskey，替代缺失的 OfWp。 */
  makeAeskey(): string {
    return randomBytes(8).toString("hex");
  }

  /** 以 aeskey 做 AES-CBC 加密并自定义 base64 编码（encrypt.js 的
   *  GxkI.QLsv(vUUf().encrypt1(plain, aeskey))）。
   *  与 slide 的 _encrypt(u,s) 不同：这里密钥是客户端随机 aeskey，
   *  而非 get.php 下发的服务端 s；用于 fullpage-w / ajax-w 构造。 */
  aesEncrypt(plaintext: string, aeskey: string): string {
    const bytes = new this.ctx.vUUf().encrypt1(plaintext, aeskey);
    return this.ctx.GxkI.QLsv(bytes);
  }
}
export function getGeetestV3Js(): GeetestV3Js {
  if (!cache) cache = new GeetestV3Js();
  return cache;
}
