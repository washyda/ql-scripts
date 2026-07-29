/**
 * 米哈游会话 HTTP 客户端。
 *
 * 移植自 cloudgame_checkin main.cpp::HttpSession / CookieJar。
 * 维护一份 cookie jar，自动带 cookie 并捕获 set-cookie，
 * 同时可选捕获 x-rpc-aigis 报头供极验二次校验。
 */
import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type RawAxiosRequestHeaders,
} from "axios";

interface Cookie {
  name: string;
  value: string;
  domain: string;
}

export class CookieJar {
  private cookies: Cookie[] = [];

  set(name: string, value: string, domain = ""): void {
    const existing = this.cookies.find(
      (c) => c.name === name && c.domain === domain,
    );
    if (existing) {
      existing.value = value;
      return;
    }
    this.cookies.push({ name, value, domain });
  }

  headerFor(host: string): string {
    const parts: string[] = [];
    for (const c of this.cookies) {
      let d = c.domain;
      if (d.startsWith(".")) d = d.slice(1);
      if (d && !host.includes(d)) continue;
      parts.push(`${c.name}=${c.value}`);
    }
    return parts.join("; ");
  }

  setFromSetCookie(values: string[] | string | undefined, host: string): void {
    if (!values) return;
    const list = Array.isArray(values) ? values : [values];
    for (const item of list) {
      const first = item.split(";")[0] ?? "";
      const eq = first.indexOf("=");
      if (eq === -1) continue;
      this.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim(), host);
    }
  }
}

export interface MiHoYoResponse<T = unknown> {
  status: number;
  data: T;
  aigisHeader: string | undefined;
}

export class HttpSession {
  readonly cookies = new CookieJar();
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      timeout: 30_000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
  }

  async request<T = unknown>(
    method: "GET" | "POST",
    url: string,
    headers: RawAxiosRequestHeaders = {},
    body = "",
    contentType = "application/json",
  ): Promise<MiHoYoResponse<T>> {
    const host = new URL(url).host;
    const cookie = this.cookies.headerFor(host);
    const finalHeaders: RawAxiosRequestHeaders = { ...headers };
    if (cookie) finalHeaders["Cookie"] = cookie;

    const config: AxiosRequestConfig = { method, url, headers: finalHeaders };
    if (method === "POST") {
      config.data = body;
      finalHeaders["Content-Type"] = contentType;
    }

    const res = await this.client.request<T>(config);

    // 捕获 set-cookie（axios 收集到数组形式）
    this.cookies.setFromSetCookie(
      res.headers["set-cookie"] as string[] | string | undefined,
      host,
    );

    return {
      status: res.status,
      data: res.data,
      aigisHeader: getHeader(res.headers, "x-rpc-aigis"),
    };
  }

  get<T = unknown>(
    url: string,
    headers: RawAxiosRequestHeaders = {},
  ): Promise<MiHoYoResponse<T>> {
    return this.request<T>("GET", url, headers);
  }

  post<T = unknown>(
    url: string,
    headers: RawAxiosRequestHeaders = {},
    body = "",
    contentType = "application/json",
  ): Promise<MiHoYoResponse<T>> {
    return this.request<T>("POST", url, headers, body, contentType);
  }
}

function getHeader(headers: unknown, name: string): string | undefined {
  const h = headers as Record<string, string | string[]>;
  for (const key of Object.keys(h)) {
    if (key.toLowerCase() === name) {
      const v = h[key];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}
