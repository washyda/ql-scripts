import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildNatFrpCheckinRequest,
  buildNatFrpCaptchaRequest,
  buildNatFrpHeaders,
  buildNatFrpSessionHeaders,
  containsPhpSession,
  formatTraffic,
  maskUsername,
} from "../scripts/natfrp_checkin";

test("formatTraffic handles bytes and GiB correctly", () => {
  assert.equal(formatTraffic(undefined), "未知");
  assert.equal(formatTraffic(null), "未知");
  assert.equal(formatTraffic(0), "0 B");
  assert.equal(formatTraffic(10), "10.00 B");
  assert.equal(formatTraffic(1024 * 1024), "1.00 MiB");
  assert.equal(formatTraffic(1073741824), "1.00 GiB");
  assert.equal(formatTraffic(562891940169), "524.23 GiB");
});

test("maskUsername masks username and email correctly", () => {
  assert.equal(maskUsername(undefined), "***");
  assert.equal(maskUsername("ab"), "ab***");
  assert.equal(maskUsername("washyda"), "wa***a");
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

test("buildNatFrpSessionHeaders never sends token authentication", () => {
  const sessionHeaders = buildNatFrpSessionHeaders(
    "PHPSESSID=test-session; lang=zh-CN",
  );

  assert.equal(sessionHeaders["Cookie"], "PHPSESSID=test-session; lang=zh-CN");
  assert.equal(sessionHeaders["Authorization"], undefined);
  assert.equal(sessionHeaders["Origin"], "https://www.natfrp.com");
  assert.equal(sessionHeaders["Referer"], "https://www.natfrp.com/user/");
});

test("containsPhpSession recognizes PHPSESSID without exposing its value", () => {
  assert.equal(containsPhpSession("PHPSESSID=secret; _ga=analytics"), true);
  assert.equal(containsPhpSession("_ga=analytics; PHPSESSID=secret"), true);
  assert.equal(containsPhpSession("session=secret; _ga=analytics"), false);
});

test("buildNatFrpCheckinRequest matches the website CGI request", () => {
  const config = buildNatFrpCheckinRequest("PHPSESSID=test-session");

  assert.equal(config.url, "https://www.natfrp.com/cgi/v4/user/sign");
  assert.equal(config.method, "POST");
  assert.deepEqual(config.data, {});
  assert.equal(config.headers?.["Cookie"], "PHPSESSID=test-session");
  assert.equal(config.headers?.["Authorization"], undefined);
});

test("buildNatFrpCaptchaRequest matches the website Geetest bootstrap request", () => {
  const config = buildNatFrpCaptchaRequest("PHPSESSID=test-session");

  assert.equal(config.url, "https://www.natfrp.com/cgi/v4/user/sign?gt");
  assert.equal(config.method, "GET");
  assert.equal(config.headers?.["Cookie"], "PHPSESSID=test-session");
  assert.equal(config.headers?.["Authorization"], undefined);
});
