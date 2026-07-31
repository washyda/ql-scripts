import { logger, type Logger } from "./logger";

export interface TaskContext {
  logger: Logger;
}

export interface TaskDefinition {
  name: string;
  run(context: TaskContext): Promise<void> | void;
}

export function defineTask(task: TaskDefinition): TaskDefinition {
  return task;
}

/** 返回 [0, maxDelayMs] 内的随机启动延迟，供定时任务分散请求峰值。 */
export function randomDelay(maxDelayMs: number, random = Math.random): number {
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < 0) {
    throw new RangeError("maxDelayMs 必须是非负安全整数");
  }
  return Math.floor(random() * (maxDelayMs + 1));
}

/** 等待指定毫秒数，避免每个任务重复实现延迟逻辑。 */
export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runTask(task: TaskDefinition): Promise<void> {
  const startedAt = Date.now();
  logger.info(`开始执行：${task.name}`);

  try {
    await task.run({ logger });
    logger.info(`执行完成，耗时 ${Date.now() - startedAt}ms`);
  } catch (error) {
    const message =
      error instanceof Error ? error.stack || error.message : String(error);
    logger.error(message);
    process.exitCode = 1;
  }
}
