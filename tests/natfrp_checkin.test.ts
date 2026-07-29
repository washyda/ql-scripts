import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildNatFrpHeaders,
  detectGeetestGap,
  formatTraffic,
  maskUsername,
  solveGeetestLocally,
} from "../scripts/natfrp_checkin";

test("formatTraffic handles bytes and GiB correctly", () => {
  assert.equal(formatTraffic(undefined), "未知");
  assert.equal(formatTraffic(null), "未知");
  assert.equal(formatTraffic(0), "0 B");
  assert.equal(formatTraffic(10), "10.00 GiB");
  assert.equal(formatTraffic(1024 * 1024), "1.00 MiB");
  assert.equal(formatTraffic(1073741824), "1.00 GiB");
});

test("maskUsername masks username and email correctly", () => {
  assert.equal(maskUsername(undefined), "***");
  assert.equal(maskUsername("ab"), "ab***");
  assert.equal(maskUsername("natfrpuser"), "na***r");
  assert.equal(maskUsername("user@example.com"), "us***@example.com");
  assert.equal(maskUsername("a@b.com"), "a***@b.com");
});

test("buildNatFrpHeaders identifies tokens vs cookies correctly", () => {
  const tokenHeaders = buildNatFrpHeaders("my_secret_token_123");
  assert.equal(tokenHeaders["Authorization"], "Bearer my_secret_token_123");
  assert.equal(tokenHeaders["Cookie"], undefined);

  const bearerHeaders = buildNatFrpHeaders("Bearer existing_token");
  assert.equal(bearerHeaders["Authorization"], "Bearer existing_token");

  const cookieHeaders = buildNatFrpHeaders("session=abc123xyz; lang=zh-CN");
  assert.equal(cookieHeaders["Cookie"], "session=abc123xyz; lang=zh-CN");
  assert.equal(cookieHeaders["Authorization"], undefined);
});

test("detectGeetestGap and solveGeetestLocally perform local gap detection and hash generation", () => {
  const dummyPixelData = new Uint8Array(260 * 160 * 4);
  const gapX = detectGeetestGap(260, 160, dummyPixelData);
  assert.ok(gapX >= 35 && gapX <= 225, "识别到的缺口位置应在合规范围");

  const localRes = solveGeetestLocally("challenge_test_123", gapX);
  assert.ok(localRes.validate.startsWith("challenge_test_123_"));
  assert.ok(localRes.seccode.includes("|jordan"));
});
