# 运行时和依赖要求

## 基础环境

青龙提供 Node.js 和 TypeScript 任务执行能力。本仓库以 Node.js 18 为最低兼容版本，任务源码由青龙直接运行，不经过仓库构建步骤。

## 依赖分类

| 分类       | 内容                                 | 安装位置                                                  |
| ---------- | ------------------------------------ | --------------------------------------------------------- |
| 基础运行时 | Node.js、青龙的 TypeScript 执行器    | 青龙基础环境提供                                          |
| 运行依赖   | axios、moment、pngjs                 | 青龙「依赖管理」的 NodeJS 类型，同时记录于 `dependencies` |
| 开发依赖   | TypeScript、tsx、Prettier、Node 类型 | 本地或 CI 通过 `npm install` 安装                         |

青龙中需要建立以下 NodeJS 依赖：

```text
axios
moment
pngjs
```

> `pngjs` 用于云·原神与 NatFrp 签到脚本解码极验滑块缺口 PNG 图片（纯 JavaScript 实现，无需 native 编译）。

## 共享封装

- `src/core/http.ts`：axios 实例、15 秒默认超时和统一 User-Agent。
- `src/core/time.ts`：moment 和统一时间格式。
- `src/core/env.ts`：必填、可选变量及多账号拆分。

## 新增依赖规则

1. 运行时代码使用的包加入 `dependencies`。
2. 只用于测试、格式或类型检查的包加入 `devDependencies`。
3. 提交 `package.json` 和 `package-lock.json`。
4. 在本文档列出青龙依赖类型和安装名称。
5. 优先通过 `src/core/` 封装公共用法，避免任务各自配置超时、时间格式等行为。

不要假设本地 `node_modules` 会随订阅上传到青龙；运行依赖必须在青龙依赖管理中安装。
