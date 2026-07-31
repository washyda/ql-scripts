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

/** 返回闭区间内的随机延迟，供任务在同一分钟内错峰启动。 */
export function randomDelayBetween(
  minimumDelayMs: number,
  maximumDelayMs: number,
  random = Math.random,
): number {
  if (
    !Number.isSafeInteger(minimumDelayMs) ||
    !Number.isSafeInteger(maximumDelayMs) ||
    minimumDelayMs < 0 ||
    maximumDelayMs < minimumDelayMs
  ) {
    throw new RangeError("延迟范围必须是递增的非负安全整数");
  }
  return (
    minimumDelayMs +
    Math.floor(random() * (maximumDelayMs - minimumDelayMs + 1))
  );
}

/** 等待指定毫秒数。 */
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
