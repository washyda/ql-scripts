import assert from "node:assert/strict";
import test from "node:test";

import { customBase64FromHex } from "../src/core/mihoyo/crypto";
import {
  buildDirectTokenHeaders,
  createDirectTokenSession,
} from "../src/core/mihoyo/client";
import { generateW, proofOfWork } from "../src/core/captcha/geetest_v4";
import { estimateOffsetFromBytes } from "../src/core/captcha/offset_estimator";
import { PNG } from "pngjs";

test("customBase64FromHex encodes 3 hex chars to 2 base64 chars", () => {
  // "000" -> 0 -> AA
  assert.equal(customBase64FromHex("000"), "AA==");
  // "fff" -> 4095 -> "//"
  assert.equal(customBase64FromHex("fff"), "//==");
  // "010" -> 16 -> AQ (16>>6=0->A, 16&63=16->Q)
  assert.equal(customBase64FromHex("010"), "AQ==");
});

test("customBase64FromHex length is multiple of 4", () => {
  const out = customBase64FromHex("abcdef0123");
  assert.equal(out.length % 4, 0);
});

test("direct token session keeps captured credentials and uses MHYY defaults", () => {
  const session = createDirectTokenSession({
    comboToken: "redacted-token",
    deviceId: "captured-device-id",
  });

  assert.equal(session.mode, "direct-token");
  assert.equal(session.comboToken, "redacted-token");
  assert.equal(session.deviceId, "captured-device-id");
  assert.equal(session.clientType, "5");
  assert.equal(session.sysVersion, "14.0");
  assert.equal(session.appVersion, "5.0.0");

  const headers = buildDirectTokenHeaders(session);
  assert.equal(headers["x-rpc-combo_token"], "redacted-token");
  assert.equal(headers["x-rpc-device_id"], "captured-device-id");
  assert.equal(headers["x-rpc-channel"], "cyydmihoyo");
});

test("proofOfWork bits=0 returns deterministic structure", () => {
  const res = proofOfWork(
    "lot123",
    "cap456",
    "1",
    "md5",
    0,
    "2024-01-01T00:00:00+08:00",
  );
  assert.ok(res.powMsg.startsWith("1|0|md5|"));
  assert.match(res.powSign, /^[0-9a-f]{32}$/);
});

test("generateW produces AES hex + RSA hex concatenation", () => {
  const w = generateW({
    setLeft: 100,
    passTime: 2000,
    lotNumber: "0".repeat(32),
    powDetail: {
      version: "1",
      hashfunc: "md5",
      bits: 0,
      datetime: "2024-01-01T00:00:00+08:00",
    },
    captchaId: "captcha_id_placeholder",
    imgWidth: 340,
  });
  // AES-CBC output length is multiple of 32 hex chars per 16-byte block;
  // RSA-1024 ciphertext is 128 bytes = 256 hex chars, trailing the string.
  assert.ok(w.length > 256);
  assert.match(w, /^[0-9a-f]+$/);
  assert.equal(w.slice(-256).length, 256);
});

test("estimateOffsetFromBytes locates a synthetic gap", () => {
  // 构造一张 340x160 背景图，用位置派生伪随机但不对称的纹理填充，
  // 保证某 60x60 缺口块的纹理在整张图上唯一，模板匹配只能在真实缺口处峰值。
  const W = 340;
  const H = 160;
  // 简易确定性伪随机：xorshift seed 由坐标决定
  function pix(x: number, y: number): [number, number, number] {
    let s = (x * 2654435761 + y * 40503) >>> 0;
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return [s & 255, (s >> 8) & 255, (s >> 16) & 255];
  }
  const bg = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const [r, g, b] = pix(x, y);
      bg.data[i] = r;
      bg.data[i + 1] = g;
      bg.data[i + 2] = b;
      bg.data[i + 3] = 255;
    }
  }
  const bgBytes = PNG.sync.write(bg);

  // 构造 slice：从背景某已知偏移处裁一块作为模板，带 alpha
  const targetX = 160;
  const targetY = 50;
  const tileW = 60;
  const tileH = 60;
  const slice = new PNG({ width: tileW, height: tileH });
  for (let y = 0; y < tileH; y++) {
    for (let x = 0; x < tileW; x++) {
      const si = (y * tileW + x) * 4;
      const bx = targetX + x;
      const by = targetY + y;
      const bi = (by * W + bx) * 4;
      slice.data[si] = bg.data[bi]!;
      slice.data[si + 1] = bg.data[bi + 1]!;
      slice.data[si + 2] = bg.data[bi + 2]!;
      slice.data[si + 3] = 255;
    }
  }
  const sliceBytes = PNG.sync.write(slice);

  const result = estimateOffsetFromBytes(sliceBytes, bgBytes);
  // 横向偏移应落在已知缺口 x 附近（容差 5 像素）
  assert.ok(
    Math.abs(result.horizontalOffset - targetX) <= 5,
    `expected ~${targetX}, got ${result.horizontalOffset}`,
  );
  assert.equal(result.imageWidth, W);
});
