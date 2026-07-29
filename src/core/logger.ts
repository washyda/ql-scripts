export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

function timestamp(): string {
  return new Date().toLocaleString("zh-CN", {
    hour12: false,
    timeZone: process.env.TZ || "Asia/Shanghai",
  });
}

function write(level: string, message: string): void {
  console.log(`[${timestamp()}] [${level}] ${message}`);
}

export const logger: Logger = {
  info: (message) => write("INFO", message),
  warn: (message) => write("WARN", message),
  error: (message) => write("ERROR", message),
};
