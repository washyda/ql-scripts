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
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { createContext, runInContext, type Context } from "node:vm";

// 当前文件位于 src/core/captcha/，JS 资源在其下的 v3/js/。
// 用模块相对路径解析，兼容 tsx(CJS) 与青龙运行时。
const JS_DIR = resolve(__dirname, "v3", "js");

function loadScript(ctx: Context, file: string): void {
  // JS 源自 geetest-crack（GBK 写出，但实际为纯 ASCII，按 latin1 读取避免任何编码干扰）
  const code = readFileSync(join(JS_DIR, file), "latin1");
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
    loadScript(ctx, "u_params.js");
    loadScript(ctx, "encrypt.js");
    loadScript(ctx, "slide_a.js");
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
