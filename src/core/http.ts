import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";

export const http = axios.create({
  timeout: 15_000,
  headers: {
    "User-Agent": "ql-scripts/1.0",
  },
});

/** 发起请求并返回响应数据，统一复用仓库级超时和 User-Agent。 */
export async function request<T>(config: AxiosRequestConfig): Promise<T> {
  const response = await requestWithResponse<T>(config);
  return response.data;
}

/** 发起请求并保留状态码、响应头等元信息。 */
export async function requestWithResponse<T>(
  config: AxiosRequestConfig,
): Promise<AxiosResponse<T>> {
  return http.request<T>(config);
}
