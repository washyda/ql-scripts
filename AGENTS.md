# AGENTS.md

本文件约束整个仓库中的开发者和自动化编码代理。

## 项目约定

- 青龙直接订阅并执行 `scripts/` 目录中的 TypeScript，不生成 JavaScript 发布文件。
- 可执行任务放在 `scripts/*.ts`，共享能力放在 `src/core/*.ts`，测试放在 `tests/*.test.ts`。
- Node.js 和 TypeScript 执行器由青龙基础环境提供；第三方包由青龙依赖管理安装，并在本仓库 `package.json`、`package-lock.json` 中维护版本。

## 开发规则

1. 每个任务必须是 `scripts/` 第一层的 `.ts` 文件，文件名使用小写字母、数字和下划线。
2. 每个任务顶部必须声明 `@name`、`@description`、六段 `@cron` 和正确的 `script-path`，且紧跟详细的中文使用说明注释（包含任务功能、所需环境变量、多账号分割方式及具体配置方法）。
3. 任务应通过 `defineTask` 和 `runTask` 使用统一生命周期与退出码。
4. 网络请求复用 `src/core/http.ts`，时间处理复用 `src/core/time.ts`，环境变量复用 `src/core/env.ts`。
5. 密钥、Cookie、Token 和个人数据不得写入源码、测试样例或完整日志。
6. 新增运行依赖时更新依赖文档，并说明如何在青龙「依赖管理」中安装。
7. 不创建、不提交编译后的任务 `.js`，也不增加构建发布步骤。
8. 兼容 Node.js 18，不使用缺少兼容处理的新版本专属 API。
9. 变更完成后必须执行 `npm run check` 和受影响脚本的直接运行测试。
10. 默认每日任务使用青龙六段 cron `0 12 8 * * *`（每天 08:12）；如需错峰，通过 `src/core/task.ts` 的共享延迟工具在启动后额外随机等待 1–30 秒。不要使用非标准的 `~` Cron 语法或 `0 0-59 8 * * *`，后者会在一小时内每分钟重复执行。

## 文档同步

- 任务路径或订阅正则变化：更新 README 和 `docs/subscription.md`。
- 目录、模板或开发流程变化：更新 `docs/development.md`。
- 依赖或最低 Node.js 版本变化：更新 `docs/dependencies.md`。
- cron、环境变量和维护流程变化：更新 README 及 `docs/maintenance.md`。

若文档与代码冲突，以任务文件头、`package.json` 和实际校验结果为准，并在同一变更中修正文档。
