/**
 * 极验 v4 滑块缺口偏移识别。
 *
 * 移植自 cloudgame_checkin 的 offset_estimator.hpp（C++/stb_image）。
 * 思路：解码带 Alpha 的小图与 RGB 背景图，提取小图非透明区域作为模板，
 * 用 Scharr 算子求梯度幅值并做 3×3 高斯平滑，再以 ZNCC（归一化互相关）
 * 在背景图上做模板匹配，定位缺口横向偏移。
 *
 * 纯数值运算，仅依赖 pngjs 解码 PNG；与浏览器、canvas、打码服务无关。
 */
import { PNG } from "pngjs";

interface DecodedImage {
  /** 像素数据，每个像素 sourceChannels 个分量，行优先 */
  data: Uint8Array;
  width: number;
  height: number;
  /** 原图实际通道数（pngjs 解码 RGBA 时始终为 4，但保留字段以对齐语义） */
  sourceChannels: number;
}

/** 解码 PNG 字节为指定通道数的位图。 */
function decode(
  bytes: Buffer,
  desiredChannels: 3 | 4,
  name: string,
): DecodedImage {
  if (bytes.length === 0) {
    throw new Error(`${name}字节数据为空`);
  }
  const png = PNG.sync.read(bytes);
  if (png.width <= 0 || png.height <= 0) {
    throw new Error(`${name}尺寸无效`);
  }
  // pngjs data 可能基于非 ArrayBuffer，统一拷贝到一个 ArrayBuffer-backed Uint8Array
  const src = new Uint8Array(png.width * png.height * 4);
  src.set(png.data as Uint8Array<ArrayBufferLike>);
  // pngjs 始终输出 RGBA
  const sourceChannels = 4;

  if (desiredChannels === 4) {
    return { data: src, width: png.width, height: png.height, sourceChannels };
  }

  const out = new Uint8Array(png.width * png.height * 3);
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
    out[j] = src[i]!;
    out[j + 1] = src[i + 1]!;
    out[j + 2] = src[i + 2]!;
  }
  return { data: out, width: png.width, height: png.height, sourceChannels };
}

class GrayImage {
  width: number;
  height: number;
  pixels: Float32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Float32Array(width * height);
  }

  at(x: number, y: number): number {
    return this.pixels[y * this.width + x]!;
  }

  set(x: number, y: number, value: number): void {
    this.pixels[y * this.width + x] = value;
  }
}

interface Point {
  x: number;
  y: number;
}

/** reflect101 边界填充：镜像反射，与 OpenCV BORDER_REFLECT_101 一致。 */
function reflect101(position: number, length: number): number {
  if (length <= 1) return 0;
  let p = position;
  while (p < 0 || p >= length) {
    if (p < 0) {
      p = -p;
    } else {
      p = 2 * length - p - 2;
    }
  }
  return p;
}

/** 从解码位图中裁剪并转灰度。 */
function toGray(
  data: Uint8Array,
  sourceWidth: number,
  channels: number,
  cropX0: number,
  cropY0: number,
  cropWidth: number,
  cropHeight: number,
): GrayImage {
  const result = new GrayImage(cropWidth, cropHeight);
  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const sourceX = cropX0 + x;
      const sourceY = cropY0 + y;
      const index = (sourceY * sourceWidth + sourceX) * channels;
      const red = data[index]!;
      const green = data[index + 1]!;
      const blue = data[index + 2]!;
      result.set(x, y, 0.299 * red + 0.587 * green + 0.114 * blue);
    }
  }
  return result;
}

// Scharr 算子
const SCHARR_X = [
  [-3, 0, 3],
  [-10, 0, 10],
  [-3, 0, 3],
];
const SCHARR_Y = [
  [-3, -10, -3],
  [0, 0, 0],
  [3, 10, 3],
];
// 3×3 高斯核（归一化系数 1/16）
const GAUSSIAN = [
  [1, 2, 1],
  [2, 4, 2],
  [1, 2, 1],
];

/** 梯度幅值图：Scharr 求梯度 → 高斯平滑。 */
function gradientMagnitude(gray: GrayImage): GrayImage {
  const magnitude = new GrayImage(gray.width, gray.height);

  for (let y = 0; y < gray.height; y++) {
    for (let x = 0; x < gray.width; x++) {
      let gx = 0;
      let gy = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        const sy = reflect101(y + offsetY, gray.height);
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          const sx = reflect101(x + offsetX, gray.width);
          const value = gray.at(sx, sy);
          gx += value * SCHARR_X[offsetY + 1]![offsetX + 1]!;
          gy += value * SCHARR_Y[offsetY + 1]![offsetX + 1]!;
        }
      }
      magnitude.set(x, y, Math.hypot(gx, gy));
    }
  }

  const blurred = new GrayImage(gray.width, gray.height);
  for (let y = 0; y < gray.height; y++) {
    for (let x = 0; x < gray.width; x++) {
      let sum = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        const sy = reflect101(y + offsetY, gray.height);
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          const sx = reflect101(x + offsetX, gray.width);
          sum += magnitude.at(sx, sy) * GAUSSIAN[offsetY + 1]![offsetX + 1]!;
        }
      }
      blurred.set(x, y, sum / 16.0);
    }
  }
  return blurred;
}

function countMaskPixels(mask: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0) count++;
  }
  return count;
}

/** 3×3 腐蚀：任一邻域为 0 则置 0。 */
function erodeMask3x3(
  mask: Uint8Array<ArrayBufferLike>,
  width: number,
  height: number,
): Uint8Array<ArrayBufferLike> {
  const eroded = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let keep = true;
      for (let offsetY = -1; offsetY <= 1 && keep; offsetY++) {
        const sy = y + offsetY;
        if (sy < 0 || sy >= height) continue;
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          const sx = x + offsetX;
          if (sx < 0 || sx >= width) continue;
          if (mask[sy * width + sx] === 0) {
            keep = false;
            break;
          }
        }
      }
      if (keep) eroded[y * width + x] = 255;
    }
  }
  return eroded;
}

interface TemplateStats {
  sum: number;
  variance: number;
}

function calculateTemplateStats(
  image: GrayImage,
  validPoints: Point[],
): TemplateStats {
  let sum = 0;
  let squareSum = 0;
  for (const point of validPoints) {
    const value = image.at(point.x, point.y);
    sum += value;
    squareSum += value * value;
  }
  const count = validPoints.length;
  return { sum, variance: squareSum - (sum * sum) / count };
}

/** 单点 ZNCC（归一化互相关）。 */
function znccAt(
  background: GrayImage,
  templ: GrayImage,
  validPoints: Point[],
  templateStats: TemplateStats,
  matchX: number,
  matchY: number,
): number {
  let imageSum = 0;
  let imageSquareSum = 0;
  let imageTemplateSum = 0;
  for (const point of validPoints) {
    const imageValue = background.at(matchX + point.x, matchY + point.y);
    const templateValue = templ.at(point.x, point.y);
    imageSum += imageValue;
    imageSquareSum += imageValue * imageValue;
    imageTemplateSum += imageValue * templateValue;
  }
  const count = validPoints.length;
  const covariance = imageTemplateSum - (imageSum * templateStats.sum) / count;
  const imageVariance = imageSquareSum - (imageSum * imageSum) / count;
  const denominator = Math.sqrt(
    Math.max(templateStats.variance * imageVariance, 0),
  );
  if (denominator <= 1e-6) return -1;
  return Math.min(Math.max(covariance / denominator, -1), 1);
}

export interface OffsetResult {
  /** 缺口横向偏移像素值（最终 setLeft） */
  horizontalOffset: number;
  /** 背景图宽度（用于 userresponse 换算） */
  imageWidth: number;
}

/**
 * 从小图与背景图字节估算缺口横向偏移。
 *
 * @param sliceBytes 带 Alpha 通道的小图 PNG 字节。
 * @param backgroundBytes 背景图 PNG 字节。
 * @param alphaThreshold 小图 Alpha 判定阈值，默认 30。
 * @param minScore 匹配置信度下限，默认 0.35。
 */
export function estimateOffsetFromBytes(
  sliceBytes: Buffer,
  backgroundBytes: Buffer,
  alphaThreshold = 30,
  minScore = 0.35,
): OffsetResult {
  const piece = decode(sliceBytes, 4, "小图");
  if (piece.sourceChannels !== 4) {
    throw new Error("小图必须是带 Alpha 通道的四通道图片");
  }
  const background = decode(backgroundBytes, 3, "背景图");

  let cropX0 = piece.width;
  let cropY0 = piece.height;
  let cropX1 = -1;
  let cropY1 = -1;
  let visiblePixelCount = 0;

  for (let y = 0; y < piece.height; y++) {
    for (let x = 0; x < piece.width; x++) {
      const index = (y * piece.width + x) * 4;
      const alpha = piece.data[index + 3]!;
      if (alpha > alphaThreshold) {
        visiblePixelCount++;
        if (x < cropX0) cropX0 = x;
        if (y < cropY0) cropY0 = y;
        if (x + 1 > cropX1) cropX1 = x + 1;
        if (y + 1 > cropY1) cropY1 = y + 1;
      }
    }
  }

  if (visiblePixelCount < 100) {
    throw new Error("小图中的有效非透明像素过少");
  }

  const templateWidth = cropX1 - cropX0;
  const templateHeight = cropY1 - cropY0;

  if (templateWidth > background.width || templateHeight > background.height) {
    throw new Error("小图的有效区域尺寸大于背景图，无法进行匹配");
  }

  const templateGray = toGray(
    piece.data,
    piece.width,
    4,
    cropX0,
    cropY0,
    templateWidth,
    templateHeight,
  );
  const backgroundGray = toGray(
    background.data,
    background.width,
    3,
    0,
    0,
    background.width,
    background.height,
  );

  // 构造掩膜：小图 Alpha>=250 视为不透明模板像素
  let mask: Uint8Array<ArrayBufferLike> = new Uint8Array(
    templateWidth * templateHeight,
  );
  for (let y = 0; y < templateHeight; y++) {
    for (let x = 0; x < templateWidth; x++) {
      const sourceX = cropX0 + x;
      const sourceY = cropY0 + y;
      const sourceIndex = (sourceY * piece.width + sourceX) * 4;
      if (piece.data[sourceIndex + 3]! >= 250) {
        mask[y * templateWidth + x] = 255;
      }
    }
  }

  const erodedMask = erodeMask3x3(mask, templateWidth, templateHeight);
  if (countMaskPixels(erodedMask) >= 100) {
    mask = erodedMask;
  }

  if (countMaskPixels(mask) < 50) {
    throw new Error("用于匹配的有效模板像素过少");
  }

  const validPoints: Point[] = [];
  for (let y = 0; y < templateHeight; y++) {
    for (let x = 0; x < templateWidth; x++) {
      if (mask[y * templateWidth + x] !== 0) {
        validPoints.push({ x, y });
      }
    }
  }

  const templateGradient = gradientMagnitude(templateGray);
  const backgroundGradient = gradientMagnitude(backgroundGray);

  const intensityStats = calculateTemplateStats(templateGray, validPoints);
  const gradientStats = calculateTemplateStats(templateGradient, validPoints);

  const resultWidth = background.width - templateWidth + 1;
  const resultHeight = background.height - templateHeight + 1;

  let bestScore = -Infinity;
  let bestMatchX = 0;

  for (let matchY = 0; matchY < resultHeight; matchY++) {
    for (let matchX = 0; matchX < resultWidth; matchX++) {
      const intensityScore = znccAt(
        backgroundGray,
        templateGray,
        validPoints,
        intensityStats,
        matchX,
        matchY,
      );
      const gradientScore = znccAt(
        backgroundGradient,
        templateGradient,
        validPoints,
        gradientStats,
        matchX,
        matchY,
      );
      const combinedScore = 0.3 * intensityScore + 0.7 * gradientScore;
      if (combinedScore > bestScore) {
        bestScore = combinedScore;
        bestMatchX = matchX;
      }
    }
  }

  if (bestScore < minScore) {
    throw new Error(`匹配置信度过低：${bestScore} < ${minScore}`);
  }

  return {
    horizontalOffset: bestMatchX - cropX0,
    imageWidth: background.width,
  };
}
