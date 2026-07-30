/**
 * 极验 3 滑块缺口偏移识别。
 *
 * 移植自 geetest-crack 的 utils/captcha.py。
 * 极验 3 的滑块背景图会被切成 52 块打乱，需先按固定顺序表还原，
 * 再用「带缺口图」与「不带缺口图」逐像素对比求最左侧差异横坐标。
 *
 * 仅依赖 pngjs 解码 PNG；与米哈游极验 v4 的 Scharr/ZNCC 路线不同，
 * 极验 3 用的是更简单的还原 + 像素差异。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import decodeJpeg, { init as initJpeg } from "@jsquash/jpeg/decode";

// @jsquash/jpeg 默认 glue code 用浏览器 fetch 加载 wasm，Node 下报
// "not implemented... yet"。首次解码前以文件读入的 wasm 显式初始化。
// wasm 路径由 require.resolve 解析 decode.js 后定位其同包 codec 目录，
// 跨源码/编译/青龙运行时一致。
let jpegReady: Promise<void> | null = null;
function ensureJpeg(): Promise<void> {
  if (!jpegReady) {
    jpegReady = (async () => {
      const decodeJsPath = require.resolve("@jsquash/jpeg/decode");
      const wasmPath = join(
        dirname(decodeJsPath),
        "codec",
        "dec",
        "mozjpeg_dec.wasm",
      );
      const wasmBinary = readFileSync(wasmPath);
      await initJpeg({ wasmBinary } as never);
    })().catch((e) => {
      jpegReady = null; // 失败则允许下次重试
      throw e;
    });
  }
  return jpegReady;
}

interface Image {
  width: number;
  height: number;
  /** RGBA 像素，行优先 */
  data: Uint8Array;
}

function isJpeg(bytes: Buffer): boolean {
  // JPEG SOI magic: FF D8 FF
  return (
    bytes.length > 2 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  );
}

function decodePng(bytes: Buffer): Image {
  const png = PNG.sync.read(bytes);
  const data = new Uint8Array(png.width * png.height * 4);
  data.set(png.data as Uint8Array<ArrayBufferLike>);
  return { width: png.width, height: png.height, data };
}

/** 解码 PNG 或 JPEG 为 RGBA 行优先位图。JPEG 走 @jsquash/jpeg（异步 wasm）。 */
async function decodeImage(bytes: Buffer): Promise<Image> {
  if (isJpeg(bytes)) {
    await ensureJpeg();
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const img = await decodeJpeg(ab);
    return {
      width: img.width,
      height: img.height,
      data: new Uint8Array(img.data.buffer as ArrayBuffer),
    };
  }
  return decodePng(bytes);
}

// 极验 3 打乱还原表：索引 c 处的像素块来自原图 img_list[c]。
const RESTORE_TABLE = [
  39, 38, 48, 49, 41, 40, 46, 47, 35, 34, 50, 51, 33, 32, 28, 29, 27, 26, 36,
  37, 31, 30, 44, 45, 43, 42, 12, 13, 23, 22, 14, 15, 21, 20, 8, 9, 25, 24, 6,
  7, 3, 2, 0, 1, 11, 10, 4, 5, 19, 18, 16, 17,
];

const BG_WIDTH = 312; // 还原图宽度
const BG_HEIGHT = 160; // 还原图高度
const HALF = BG_HEIGHT / 2; // 80
const SLICE_W = 10; // 每块宽度

/**
 * 还原打乱的极验 3 背景图，返回 312×160 的 RGBA 位图。
 * 52 块，上下两行各 26 块；每块宽 10、高 80。
 */
function restoreImage(img: Image): Image {
  const out = new Uint8Array(BG_WIDTH * BG_HEIGHT * 4);
  for (let c = 0; c < 52; c++) {
    const src = RESTORE_TABLE[c]!;
    // 源块左上 x：src % 26 * 12 + 1；y：src > 25 ? 80 : 0
    const fX = (src % 26) * 12 + 1;
    const fY = src > 25 ? HALF : 0;
    // 目标块左上 x：c % 26 * 10；y：c > 25 ? 80 : 0
    const tX = (c % 26) * 10;
    const tY = c > 25 ? HALF : 0;

    for (let y = 0; y < HALF; y++) {
      for (let x = 0; x < SLICE_W; x++) {
        const si = ((fY + y) * img.width + (fX + x)) * 4;
        const di = ((tY + y) * BG_WIDTH + (tX + x)) * 4;
        out[di] = img.data[si]!;
        out[di + 1] = img.data[si + 1]!;
        out[di + 2] = img.data[si + 2]!;
        out[di + 3] = img.data[si + 3]!;
      }
    }
  }
  return { width: BG_WIDTH, height: BG_HEIGHT, data: out };
}

/** 像素差异是否过大（R、G、B 同时超阈值）。 */
function pixelDiff(p1: Uint8Array, p2: Uint8Array, i: number): boolean {
  const diffMax = 50;
  const dr = Math.abs(p1[i]! - p2[i]!);
  const dg = Math.abs(p1[i + 1]! - p2[i + 1]!);
  const db = Math.abs(p1[i + 2]! - p2[i + 2]!);
  return dr > diffMax && dg > diffMax && db > diffMax;
}

export interface V3OffsetResult {
  /** 缺口最左侧横坐标（含 -3 偏移修正） */
  offset: number;
}

/**
 * 计算带缺口图与不带缺口图的缺口横向偏移。
 *
 * @param gapBytes 带缺口的背景图字节（PNG 打乱图或 JPEG 成品图）。
 * @param fullBytes 不带缺口的完整背景图字节（PNG 打乱图或 JPEG 成品图）。
 */
export async function calculateV3Offset(
  gapBytes: Buffer,
  fullBytes: Buffer,
): Promise<V3OffsetResult> {
  const gapRaw = await decodeImage(gapBytes);
  const fullRaw = await decodeImage(fullBytes);
  // 旧版极验 3 下发打乱的 PNG 源图（宽 312），需按还原表还原；
  // 新版（NatFrp multilink）下发的 JPEG 已是成品图，直接对比即可。
  const isScrambledPng =
    !isJpeg(gapBytes) &&
    gapRaw.width === BG_WIDTH &&
    fullRaw.width === BG_WIDTH;
  const gap = isScrambledPng ? restoreImage(gapRaw) : gapRaw;
  const full = isScrambledPng ? restoreImage(fullRaw) : fullRaw;

  const xs: number[] = [];
  for (let y = 0; y < gap.height; y++) {
    for (let x = 0; x < gap.width; x++) {
      const i = (y * gap.width + x) * 4;
      if (pixelDiff(gap.data, full.data, i)) {
        xs.push(x);
      }
    }
  }
  if (xs.length === 0) {
    throw new Error("未检测到缺口像素差异");
  }
  xs.sort((a, b) => a - b);
  // geetest-crack 取最左侧差异 x 减 3 作为滑块偏移
  return { offset: xs[0]! - 3 };
}
