import assert from "node:assert/strict";
import test from "node:test";

import { customBase64FromHex } from "../src/core/mihoyo/crypto";
import {
  MiHoYoApiClient,
  assertCloudgameOk,
  buildDirectTokenHeaders,
  createDirectTokenSession,
} from "../src/core/mihoyo/client";
import type { HttpSession, MiHoYoResponse } from "../src/core/mihoyo/http";
import {
  formatMinutes,
  parseNotificationReward,
  parseWallet,
} from "../scripts/cloudgame_genshin_checkin";
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

/** 构造只回放预设响应的 HttpSession 替身，并记录请求过的 URL。 */
function stubSession(responses: Record<string, MiHoYoResponse<unknown>>): {
  session: HttpSession;
  urls: string[];
} {
  const urls: string[] = [];
  const reply = (url: string): Promise<MiHoYoResponse<unknown>> => {
    urls.push(url);
    const match = Object.keys(responses).find((key) => url.startsWith(key));
    if (!match) throw new Error(`unexpected request: ${url}`);
    return Promise.resolve(responses[match]!);
  };
  const session = {
    get: (url: string) => reply(url),
    post: (url: string) => reply(url),
  } as unknown as HttpSession;
  return { session, urls };
}

const tokenCtx = createDirectTokenSession({
  comboToken: "redacted-token",
  deviceId: "captured-device-id",
});

test("getWallet unwraps the HTTP envelope so wallet fields are reachable", async () => {
  const body = {
    retcode: 0,
    message: "OK",
    data: {
      free_time: { free_time: "600" },
      play_card: { short_msg: "畅玩卡还有 3 天" },
      coin: { coin_num: "2400" },
    },
  };
  const { session } = stubSession({
    "https://api-cloudgame.mihoyo.com/hk4e_cg_cn/wallet/wallet/get": {
      status: 200,
      data: body,
      aigisHeader: undefined,
    },
  });

  const wallet = await new MiHoYoApiClient(session).getWallet(tokenCtx);
  assert.equal(wallet.retcode, 0);
  // 回归点：此前 getWallet 直接返回 {status,data,aigisHeader}，
  // 导致 data.free_time 落空、日志显示「未知」。
  assert.equal(wallet.data?.free_time?.free_time, "600");

  const stat = parseWallet(wallet);
  assert.equal(stat.freeMinutes, 600);
  assert.equal(stat.playCardMsg, "畅玩卡还有 3 天");
  assert.equal(stat.coinNum, 2400);
  assert.equal(stat.coinMinutes, 240);
  assert.equal(
    formatMinutes(stat),
    "免费时长 600 分钟 | 畅玩卡 畅玩卡还有 3 天 | 原点 2400 点（约 240 分钟）",
  );
});

test("getWallet throws on non-200 HTTP status", async () => {
  const { session } = stubSession({
    "https://api-cloudgame.mihoyo.com/hk4e_cg_cn/wallet/wallet/get": {
      status: 503,
      data: {},
      aigisHeader: undefined,
    },
  });
  await assert.rejects(
    () => new MiHoYoApiClient(session).getWallet(tokenCtx),
    /wallet HTTP 503/u,
  );
});

test("listNotifications unwraps the envelope and exposes list entries", async () => {
  const { session } = stubSession({
    "https://api-cloudgame.mihoyo.com/hk4e_cg_cn/gamer/api/listNotifications": {
      status: 200,
      data: {
        retcode: 0,
        data: { list: [{ id: "notif-1", msg: "{}" }] },
      },
      aigisHeader: undefined,
    },
  });
  const info = await new MiHoYoApiClient(session).listNotifications(tokenCtx);
  assert.equal(info.retcode, 0);
  assert.deepEqual(
    info.data?.list?.map((n) => n.id),
    ["notif-1"],
  );
});

test("assertCloudgameOk reports expired login for retcode -100", () => {
  assert.doesNotThrow(() => assertCloudgameOk({ retcode: 0 }, "查询钱包"));
  assert.throws(
    () =>
      assertCloudgameOk(
        { retcode: -100, message: "not logged in" },
        "查询钱包",
      ),
    /登录态已过期.*YS_CG_TOKEN/su,
  );
  assert.throws(
    () => assertCloudgameOk({ retcode: -1, message: "boom" }, "查询钱包"),
    /查询钱包 失败：retcode -1: boom/u,
  );
  // 缺失 retcode 视为失败，而非静默通过。
  assert.throws(() => assertCloudgameOk({}, "查询钱包"), /retcode -1/u);
});

test("parseWallet tolerates numeric fields and missing data", () => {
  const numeric = parseWallet({
    retcode: 0,
    data: {
      free_time: { free_time: 120 as unknown as string },
      coin: { coin_num: 30 as unknown as string },
    },
  });
  assert.equal(numeric.freeMinutes, 120);
  assert.equal(numeric.coinNum, 30);
  assert.equal(numeric.playCardMsg, "未知");

  const empty = parseWallet({ retcode: 0, data: {} });
  assert.equal(empty.freeMinutes, -1);
  assert.equal(empty.coinNum, -1);
  assert.equal(formatMinutes(empty), "免费时长 未知 | 畅玩卡 未知 | 原点 未知");
});

test("parseNotificationReward reads the nested JSON msg payload", () => {
  assert.equal(
    parseNotificationReward({
      id: "1",
      msg: JSON.stringify({ msg: "每日登录奖励", num: 600, over_num: 0 }),
    }),
    "每日登录奖励：获得 600 分钟",
  );
  assert.equal(
    parseNotificationReward({
      id: "2",
      msg: JSON.stringify({ msg: "每日登陆奖励", num: 100, over_num: 500 }),
    }),
    "每日登陆奖励：获得 100 分钟（免费时长已达上限，超出 500 分钟）",
  );
  // 非 JSON 或空 msg 时退回 undefined，由调用方改用钱包差值。
  assert.equal(parseNotificationReward({ id: "3", msg: "已签到" }), undefined);
  assert.equal(parseNotificationReward({ id: "4" }), undefined);
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
