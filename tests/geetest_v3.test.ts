import assert from "node:assert/strict";
import test from "node:test";

import { calculateV3Offset } from "../src/core/captcha/geetest_v3_offset";
import { getGeetestV3Js } from "../src/core/captcha/v3_js";
import { PNG } from "pngjs";

test("v3 js bridge produces slide w from given s", () => {
  const js = getGeetestV3Js();
  const s = "b64ce82712345678";
  const gt = "78aaca6a49add69b47090ba07c00fa3a";
  const challenge = "abcdef1234567890abcdef1234567890ab";
  const track = [
    [-32, -26, 0],
    [0, 0, 0],
    [0, 0, 135],
    [87, 0, 800],
    [87, 0, 1000],
  ];
  const lm = js.lmWn(gt + challenge);
  assert.match(lm, /^[0-9a-f]{32}$/);
  const userresponse = js.getUserResponse(86, challenge);
  assert.ok(typeof userresponse === "string" && userresponse.length > 0);
  const a = js.mouseEncrypt(track);
  assert.ok(typeof a === "string" && a.length > 0);
  const uenc = js.encryptU(
    {
      lang: "zh-cn",
      userresponse,
      passtime: 1000,
      imgload: 150,
      a,
      ep: { v: "7.8.6", f: lm },
      rp: lm,
    },
    s,
  );
  const aenc = js.getA(s);
  const w = uenc + aenc;
  // u 段为 geetest 自定义编码（含 () 等），a 段为 hex（256 字符）
  assert.equal(aenc.length, 256);
  assert.match(aenc, /^[0-9a-f]+$/);
  assert.ok(w.startsWith(uenc));
  assert.equal(w.length, uenc.length + 256);
});

test("v3 offset detects a synthetic gap in restored images", async () => {
  const W = 312;
  const H = 160;
  const HALF = H / 2;
  const SLICE_W = 10;
  const RESTORE_TABLE = [
    39, 38, 48, 49, 41, 40, 46, 47, 35, 34, 50, 51, 33, 32, 28, 29, 27, 26, 36,
    37, 31, 30, 44, 45, 43, 42, 12, 13, 23, 22, 14, 15, 21, 20, 8, 9, 25, 24, 6,
    7, 3, 2, 0, 1, 11, 10, 4, 5, 19, 18, 16, 17,
  ];

  // 确定性伪随机纹理
  function pix(x: number, y: number): [number, number, number] {
    let s = (x * 2654435761 + y * 40503) >>> 0;
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return [s & 255, (s >> 8) & 255, (s >> 16) & 255];
  }

  // 先构建「还原后」的理想图（带缺口在 targetGapX），再按 RESTORE_TABLE 反向打乱
  // 成极验 3 实际下发的源图，使 restoreImage 还原后缺口回到 targetGapX。
  const targetGapX = 120;
  const gapW = 30;

  const buildScrambledSource = (withGap: boolean): Buffer => {
    const src = new Uint8Array(W * H * 4);
    for (let c = 0; c < 52; c++) {
      const srcBlock = RESTORE_TABLE[c]!;
      const fX = (srcBlock % 26) * 12 + 1;
      const fY = srcBlock > 25 ? HALF : 0;
      const tX = (c % 26) * SLICE_W;
      const tY = c > 25 ? HALF : 0;
      for (let y = 0; y < HALF; y++) {
        for (let x = 0; x < SLICE_W; x++) {
          const targetX = tX + x;
          const targetY = tY + y;
          let [r, g, b] = pix(targetX, targetY);
          if (withGap && targetX >= targetGapX && targetX < targetGapX + gapW) {
            r = (r + 200) & 255;
            g = (g + 200) & 255;
            b = (b + 200) & 255;
          }
          const si = ((fY + y) * W + (fX + x)) * 4;
          src[si] = r;
          src[si + 1] = g;
          src[si + 2] = b;
          src[si + 3] = 255;
        }
      }
    }
    const png = new PNG({ width: W, height: H });
    png.data.set(src);
    return PNG.sync.write(png);
  };

  const full = buildScrambledSource(false);
  const gap = buildScrambledSource(true);

  const result = await calculateV3Offset(gap, full);
  assert.ok(
    Math.abs(result.offset - (targetGapX - 3)) <= 5,
    `expected ~${targetGapX - 3}, got ${result.offset}`,
  );
});
