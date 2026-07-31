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
// 顶层导入 decode（青龙 pnpm 仅装顶层 @jsquash/jpeg，子路径不可靠）。
import { decode as decodeJpeg } from "@jsquash/jpeg";

// @jsquash/jpeg 默认 glue code 用浏览器 fetch 加载 wasm，Node 下报
// "not implemented... yet"。首次解码前以文件读入的 wasm 显式初始化。
// 青龙仅装顶层包，故经 require.resolve("@jsquash/jpeg") 得到 index.js，
// 再定位同目录 decode.js 与 wasm，避免任何 @jsquash/jpeg/<子路径> 字面量。
let jpegReady: Promise<void> | null = null;
function ensureJpeg(): Promise<void> {
  if (!jpegReady) {
    jpegReady = (async () => {
      const indexPath = require.resolve("@jsquash/jpeg");
      const pkgDir = dirname(indexPath);
      const wasmPath = join(pkgDir, "codec", "dec", "mozjpeg_dec.wasm");
      const wasmBinary = readFileSync(wasmPath);
      const mod = require(join(pkgDir, "decode.js")) as {
        init: (opts: unknown) => Promise<void>;
      };
      await mod.init({ wasmBinary });
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

/**
 * 极验 V3 的 52 块打乱图可以是 PNG，也可以是 JPEG。不能用文件格式判断：
 * JPEG 仅是传输编码，312×160 的块布局仍然需要按 RESTORE_TABLE 还原。
 */
function isScrambledV3Image(img: Image): boolean {
  return img.width >= BG_WIDTH && img.height >= BG_HEIGHT;
}

/** 像素差异是否过大（R、G、B 同时超阈值）。 */
function pixelDiff(p1: Uint8Array, p2: Uint8Array, i: number): boolean {
  const diffMax = 50;
  const redDifference = Math.abs(p1[i]! - p2[i]!);
  const greenDifference = Math.abs(p1[i + 1]! - p2[i + 1]!);
  const blueDifference = Math.abs(p1[i + 2]! - p2[i + 2]!);
  return (
    redDifference > diffMax &&
    greenDifference > diffMax &&
    blueDifference > diffMax
  );
}

function buildEdgeMap(image: Image): Uint8Array {
  const grayscale = new Uint8Array(image.width * image.height);
  for (let pixelIndex = 0; pixelIndex < grayscale.length; pixelIndex++) {
    const sourceIndex = pixelIndex * 4;
    grayscale[pixelIndex] = Math.round(
      image.data[sourceIndex]! * 0.299 +
        image.data[sourceIndex + 1]! * 0.587 +
        image.data[sourceIndex + 2]! * 0.114,
    );
  }

  const edges = new Uint8Array(grayscale.length);
  for (let y = 1; y < image.height - 1; y++) {
    for (let x = 1; x < image.width - 1; x++) {
      const topLeft = grayscale[(y - 1) * image.width + x - 1]!;
      const top = grayscale[(y - 1) * image.width + x]!;
      const topRight = grayscale[(y - 1) * image.width + x + 1]!;
      const left = grayscale[y * image.width + x - 1]!;
      const right = grayscale[y * image.width + x + 1]!;
      const bottomLeft = grayscale[(y + 1) * image.width + x - 1]!;
      const bottom = grayscale[(y + 1) * image.width + x]!;
      const bottomRight = grayscale[(y + 1) * image.width + x + 1]!;
      const horizontalGradient =
        -topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight;
      const verticalGradient =
        -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
      const gradientMagnitude =
        Math.abs(horizontalGradient) + Math.abs(verticalGradient);
      edges[y * image.width + x] = gradientMagnitude >= 180 ? 1 : 0;
    }
  }
  return edges;
}

function findSliceTemplateOffset(
  fullBackground: Image,
  sliceImage: Image,
): number | null {
  if (
    sliceImage.width > fullBackground.width ||
    sliceImage.height > fullBackground.height
  ) {
    return null;
  }

  // 与 OpenCV TM_CCOEFF_NORMED 一样做归一化相关性匹配。滑块 PNG 有透明
  // 背景，透明像素不能参与评分；只拿可见的纹理像素，且隔点采样控制成本。
  const templatePoints: Array<readonly [x: number, y: number, value: number]> =
    [];
  for (let y = 2; y < sliceImage.height - 2; y++) {
    for (let x = 2; x < sliceImage.width - 2; x += 2) {
      const index = (y * sliceImage.width + x) * 4;
      if (sliceImage.data[index + 3]! < 200) continue;
      const value = Math.round(
        sliceImage.data[index]! * 0.299 +
          sliceImage.data[index + 1]! * 0.587 +
          sliceImage.data[index + 2]! * 0.114,
      );
      templatePoints.push([x, y, value]);
    }
  }
  if (templatePoints.length < 32) return null;

  const templateMean =
    templatePoints.reduce((sum, [, , value]) => sum + value, 0) /
    templatePoints.length;
  const templateVariance = templatePoints.reduce(
    (sum, [, , value]) => sum + (value - templateMean) ** 2,
    0,
  );
  if (templateVariance === 0) return null;

  const maximumX = fullBackground.width - sliceImage.width;
  const maximumY = fullBackground.height - sliceImage.height;
  let bestScore = -1;
  let bestX = 0;
  for (let y = 0; y <= maximumY; y++) {
    for (let x = 0; x <= maximumX; x++) {
      let fullSum = 0;
      for (const [templateX, templateY] of templatePoints) {
        const index =
          ((y + templateY) * fullBackground.width + x + templateX) * 4;
        fullSum +=
          fullBackground.data[index]! * 0.299 +
          fullBackground.data[index + 1]! * 0.587 +
          fullBackground.data[index + 2]! * 0.114;
      }
      const fullMean = fullSum / templatePoints.length;
      let covariance = 0;
      let fullVariance = 0;
      for (const [templateX, templateY, templateValue] of templatePoints) {
        const index =
          ((y + templateY) * fullBackground.width + x + templateX) * 4;
        const fullValue =
          fullBackground.data[index]! * 0.299 +
          fullBackground.data[index + 1]! * 0.587 +
          fullBackground.data[index + 2]! * 0.114;
        covariance += (templateValue - templateMean) * (fullValue - fullMean);
        fullVariance += (fullValue - fullMean) ** 2;
      }
      const score = covariance / Math.sqrt(templateVariance * fullVariance);
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
      }
    }
  }
  // 避免低置信度模板（此前会把真实 129 误判为 6）覆盖可靠差异定位。
  return bestScore >= 0.55 ? bestX : null;
}

export interface V3OffsetResult {
  /** 缺口最左侧横坐标（含 -3 偏移修正） */
  offset: number;
}

/**
 * 计算滑块应移动的横向偏移。
 *
 * 优先按 Python 示例的 fullbg + slice 模板匹配；没有 slice 时回退到
 * gap/fullbg 差异分析，以兼容旧版调用方和没有 slice 的响应。
 */
export async function calculateV3Offset(
  gapBackgroundBytes: Buffer,
  fullBackgroundBytes: Buffer,
  sliceBytes?: Buffer,
): Promise<V3OffsetResult> {
  const gapRaw = await decodeImage(gapBackgroundBytes);
  const fullRaw = await decodeImage(fullBackgroundBytes);
  // V3 源图通常是 312×160 的 52 块布局。应先还原再进行所有定位；
  // 否则 fullbg 与 slice 的模板坐标不在同一个图像坐标系，必然得到错误偏移。
  const isScrambled = isScrambledV3Image(gapRaw) && isScrambledV3Image(fullRaw);
  const gap = isScrambled ? restoreImage(gapRaw) : gapRaw;
  const full = isScrambled ? restoreImage(fullRaw) : fullRaw;
  if (sliceBytes) {
    const sliceImage = await decodeImage(sliceBytes);
    const templateOffset = findSliceTemplateOffset(full, sliceImage);
    if (templateOffset !== null) {
      // slice/fullbg 的模板坐标就是滑块应移动的实际坐标。Python/OpenCV
      // 成功链路同样直接使用该值；再减 3 会稳定落在缺口左侧。
      return { offset: templateOffset };
    }
  }

  // 逐列统计差异像素数。两张 JPG 的压缩噪声会在全图散布少量差异，
  // 但真缺口列的差异像素数远高于噪声列。取差异峰值列，向左右扩展到
  // 显著差异（>= 峰值一半）的连续区间，区间左端即缺口左边缘，比 min(x)
  // 稳健（min 易被零星噪声拉到 0）。
  // 关键：bg 图在 x=0 附近有「滑块小块起始覆盖层」（xpos:0 的 slice 叠加），
  // 其差异像素数常与真缺口相当甚至更高，会误导峰值落到小块区域。
  // 故峰值只在 slice 覆盖区之外查找（slice 宽约 52，取 60 起算留余量）。
  const colDiffs = new Array<number>(gap.width).fill(0);
  let totalDiff = 0;
  for (let y = 0; y < gap.height; y++) {
    for (let x = 0; x < gap.width; x++) {
      const i = (y * gap.width + x) * 4;
      if (pixelDiff(gap.data, full.data, i)) {
        colDiffs[x]!++;
        totalDiff++;
      }
    }
  }
  if (totalDiff === 0) {
    throw new Error("未检测到缺口像素差异");
  }
  // 跳过 slice 起始覆盖区（x<60）与右边缘渲染伪影（x>270），峰值只在中段查。
  const SLICE_SKIP = 60;
  const EDGE_SKIP = 270;
  let peakX = SLICE_SKIP,
    peakC = 0;
  for (let x = SLICE_SKIP; x < EDGE_SKIP; x++)
    if (colDiffs[x]! > peakC) {
      peakC = colDiffs[x]!;
      peakX = x;
    }
  const half = peakC / 2;
  let left = peakX;
  while (left > SLICE_SKIP && colDiffs[left - 1]! >= half) left--;
  // geetest-crack 取最左侧差异 x 减 3 作为滑块偏移
  return { offset: left - 3 };
}
