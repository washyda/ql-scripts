/**
 * @name Hello World 测试
 * @description 验证青龙订阅、TypeScript 运行环境和环境变量读取
 * @cron 0 0 8 * * *
 * cron "0 0 8 * * *" script-path=scripts/hello_world.ts,tag=ql-scripts
 */

/**
 * ==================== Hello World 脚本使用说明 ====================
 * 1. 任务用途：验证青龙订阅、TypeScript 执行环境及环境变量读取。
 * 2. 环境变量：
 *    - `HELLO_NAME`: 可选，自定义问候名称，默认值为 `QingLong`。
 * ==================================================================
 */

import { optionalEnv } from "../src/core/env";
import { defineTask, runTask } from "../src/core/task";

export function createHelloMessage(name = "QingLong"): string {
  return `Hello, ${name}! TypeScript 脚本运行成功。`;
}

export const helloWorldTask = defineTask({
  name: "Hello World 测试",
  run({ logger }) {
    const name = optionalEnv("HELLO_NAME") || "QingLong";
    logger.info(createHelloMessage(name));
    logger.info(
      `Node.js ${process.version} / ${process.platform} ${process.arch}`,
    );
  },
});

if (require.main === module) {
  void runTask(helloWorldTask);
}
