import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildNatFrpCheckinRequest,
  buildNatFrpCaptchaRequest,
  buildNatFrpHeaders,
  buildNatFrpSessionHeaders,
  containsPhpSession,
  executeNatFrpCheckinWithRetry,
  formatTraffic,
  maskUsername,
  NATFRP_CAPTCHA_MAX_ATTEMPTS,
  NATFRP_CAPTCHA_RETRY_DELAY_MS,
} from "../scripts/natfrp_daily_checkin";

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

test("NatFrp captcha retry refreshes one-time challenge before each solve", async () => {
  let requirementCalls = 0;
  const solvedChallenges: string[] = [];
  const delays: number[] = [];
  const warnings: string[] = [];

  const result = await executeNatFrpCheckinWithRetry(
    "PHPSESSID=test-session",
    {
      info: () => undefined,
      warn: (message: string) => warnings.push(message),
    },
    {
      getRequirement: async () => {
        requirementCalls += 1;
        return {
          needCaptcha: true,
          message: "captcha required",
          gt: "gt",
          challenge: `challenge-${requirementCalls}`,
        };
      },
      solveCaptcha: async (_gt, challenge) => {
        solvedChallenges.push(challenge);
        if (solvedChallenges.length < 3) {
          throw new Error("temporary geetest failure");
        }
        return {
          challenge,
          validate: "validate",
          seccode: "validate|jordan",
        };
      },
      submitCheckin: async () => ({ success: true, message: "signed" }),
      wait: async (milliseconds) => {
        delays.push(milliseconds);
      },
    },
  );

  assert.deepEqual(result, { success: true, message: "signed" });
  assert.equal(requirementCalls, 3);
  assert.deepEqual(solvedChallenges, [
    "challenge-1",
    "challenge-2",
    "challenge-3",
  ]);
  assert.deepEqual(delays, Array(2).fill(NATFRP_CAPTCHA_RETRY_DELAY_MS));
  assert.equal(warnings.length, 2);
});

test("NatFrp captcha retry stops after five complete attempts without a final delay", async () => {
  let requirementCalls = 0;
  let solveCalls = 0;
  let waitCalls = 0;

  await assert.rejects(
    executeNatFrpCheckinWithRetry(
      "PHPSESSID=test-session",
      { info: () => undefined, warn: () => undefined },
      {
        getRequirement: async () => {
          requirementCalls += 1;
          return {
            needCaptcha: true,
            message: "captcha required",
            gt: "gt",
            challenge: `challenge-${requirementCalls}`,
          };
        },
        solveCaptcha: async () => {
          solveCalls += 1;
          throw new Error("persistent geetest failure");
        },
        wait: async () => {
          waitCalls += 1;
        },
      },
    ),
    /persistent geetest failure/,
  );

  assert.equal(requirementCalls, NATFRP_CAPTCHA_MAX_ATTEMPTS);
  assert.equal(solveCalls, NATFRP_CAPTCHA_MAX_ATTEMPTS);
  assert.equal(waitCalls, NATFRP_CAPTCHA_MAX_ATTEMPTS - 1);
});

test("NatFrp captcha retry restarts at bootstrap after a rejected submission", async () => {
  const requestedChallenges: string[] = [];
  const submittedChallenges: string[] = [];

  const result = await executeNatFrpCheckinWithRetry(
    "PHPSESSID=test-session",
    { info: () => undefined, warn: () => undefined },
    {
      getRequirement: async () => {
        const challenge = `challenge-${requestedChallenges.length + 1}`;
        requestedChallenges.push(challenge);
        return {
          needCaptcha: true,
          message: "captcha required",
          gt: "gt",
          challenge,
        };
      },
      solveCaptcha: async (_gt, challenge) => ({
        challenge,
        validate: "validate",
        seccode: "validate|jordan",
      }),
      submitCheckin: async (_credential, captchaParams) => {
        submittedChallenges.push(captchaParams?.challenge ?? "");
        if (submittedChallenges.length === 1) {
          return {
            success: false,
            needCaptcha: true,
            message: "验证码校验失败",
          };
        }
        return { success: true, message: "signed" };
      },
      wait: async () => undefined,
    },
  );

  assert.equal(result.success, true);
  assert.deepEqual(requestedChallenges, ["challenge-1", "challenge-2"]);
  assert.deepEqual(submittedChallenges, ["challenge-1", "challenge-2"]);
});
