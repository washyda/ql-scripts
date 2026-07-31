# 开发规范

## 目录职责

- `scripts/`：青龙会识别为任务的可执行 TypeScript，仅放任务入口。
- `src/core/`：共享日志、环境变量、HTTP、时间和任务生命周期工具。
- `templates/`：新任务模板。
- `tests/`：Node.js 内建测试运行器配合 tsx 执行的测试。
- `docs/`：订阅、依赖和维护说明。

## 新任务流程

1. 复制 `templates/task.ts.template` 为 `scripts/example.ts`。
2. 任务开头必须使用青龙可识别的 `// @name`、`// @description`、`// @cron` 和 `// cron ... script-path=...` 行注释；兼容源码回退解析时还需添加无尾逗号的 `// name: "任务名称"` 行。其后紧跟中文使用说明注释（含用途、环境变量与多账号配置说明）。
3. 使用 `optionalEnv` 或 `requiredEnv` 读取配置，使用 `splitAccounts` 处理多账号。
4. 为纯函数、变量解析和关键分支添加测试。
5. 在 README 或任务文档中声明环境变量及青龙依赖。
6. 执行 `npm run check` 和 `npx tsx scripts/example.ts`。

## 编码规则

- TypeScript 开启 strict，避免无理由的 `any`、`@ts-ignore` 和非空断言。
- 任务入口使用 `if (require.main === module)`，使测试导入任务时不会自动执行。
- HTTP 请求必须有超时，不记录完整 Cookie、Authorization 或敏感响应。
- 多账号任务应隔离每个账号的上下文和错误。
- cron 使用青龙六段格式：秒、分、时、日、月、周。
- 默认每日任务使用 `0 12 8 * * *`（每天 08:12），并可通过 `src/core/task.ts` 的共享延迟工具额外随机等待 1–30 秒以错开秒级请求；不要使用非标准的 `~` Cron 语法或 `0 0-59 8 * * *`，后者会每分钟重复执行。
- 不编译或提交 `.js` 任务产物。

## 本地命令

```bash
npm install
npm run dev:natfrp
npm run check
npx tsx scripts/natfrp_daily_checkin.ts
```
