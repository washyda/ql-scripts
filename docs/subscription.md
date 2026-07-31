# 订阅与导入说明

## 订阅范围

青龙直接执行以下目录中的 TypeScript 任务：

```text
scripts/*.ts
```

任务引用的共享源码位于：

```text
src/core/*.ts
```

订阅时将前者配置为任务白名单，将后者配置为依赖文件。不要使用 `.*\.ts` 匹配整个仓库，否则测试和共享工具可能被错误创建成定时任务。

## 面板配置

| 字段                | 值                    |
| ------------------- | --------------------- |
| 分支                | `main`                |
| 白名单/拉取文件包含 | `^scripts/[^/]+\.ts$` |
| 黑名单/拉取文件排除 | 留空                  |
| 依赖文件            | `^src/core/.*\.ts$`   |
| 后缀                | `ts`                  |

运行订阅后，青龙应从 `scripts/hello_world.ts` 读取名称和 cron，并生成 **Hello World 测试**任务。

## 命令行

```bash
ql repo "REPOSITORY_URL" "^scripts/[^/]+\.ts$" "" "^src/core/.*\.ts$" "main"
```

旧版青龙没有自动生成任务时手动添加：

```bash
task <订阅仓库目录>/scripts/hello_world.ts
```

## 验收

先在「依赖管理」确认任务所需 NodeJS 包已经安装，再运行任务。Hello World 无第三方包调用，可直接用于检查 TS 执行能力。

## NatFrp 任务迁移

NatFrp 日常签到任务已由 `scripts/natfrp_checkin.ts` 更名为 `scripts/natfrp_daily_checkin.ts`。更新订阅后，请删除旧任务并按新文件路径重新创建或启用任务；环境变量 `NATFRP_TOKEN`、`NATFRP_COOKIE` 无需变更。
