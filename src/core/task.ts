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
