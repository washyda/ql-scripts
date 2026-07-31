# 青龙 TypeScript 脚本库模板

这是一个由青龙直接订阅并执行 TypeScript 源文件的脚本仓库，不生成或维护 JavaScript 产物。

可执行任务统一放在 `scripts/` 目录，共享代码放在 `src/core/`。

## 青龙面板订阅

先把仓库推送到 GitHub、Gitee 或其他青龙能够访问的 Git 地址，然后进入青龙「订阅管理」新建订阅：

| 配置项      | 建议值                               |
| ----------- | ------------------------------------ |
| 名称        | `ql-scripts`                         |
| 类型        | 公开仓库；私有仓库按实际情况配置凭据 |
| 仓库地址    | 仓库 HTTPS 克隆地址                  |
| 分支        | `main`                               |
| 定时规则    | `0 0 */6 * * *`                      |
| 白名单/包含 | `^scripts/[^/]+\.ts$`                |
| 黑名单/排除 | 留空                                 |
| 依赖文件    | `^src/core/.*\.ts$`                  |
| 文件后缀    | `ts`（面板有此项时填写）             |

白名单只把 `scripts/` 下第一层 `.ts` 文件识别为定时任务；依赖文件规则会同时拉取任务引用的 `src/core/` 共享代码，但不会把共享代码创建成任务。

保存后运行订阅，青龙会按每个任务文件头中的五段 cron（分、时、日、月、周）创建定时任务。

## 命令行导入

进入青龙容器终端，将 `REPOSITORY_URL` 替换成实际仓库地址：

```bash
ql repo "REPOSITORY_URL" "^scripts/[^/]+\.ts$" "" "^src/core/.*\.ts$" "main"
```

不同版本的 `ql repo` 参数可能有差异，参数不兼容时以面板订阅方式为准。

如果旧版青龙只拉取文件、没有自动创建任务，可根据订阅日志中的仓库路径手动新建：

```bash
task <订阅仓库目录>/scripts/natfrp_daily_checkin.ts
```

## Node.js 第三方依赖

青龙本身负责 Node.js 和 TypeScript 脚本运行环境。本仓库使用的第三方运行依赖维护在 `package.json`：

- `axios`：HTTP 请求
- `moment`：时间处理
- `pngjs`：解码极验滑块缺口 PNG（云·原神、NatFrp 签到）
- `@jsquash/jpeg`：解码极验 3 滑块背景 JPEG（NatFrp 签到）

在青龙「依赖管理」中新建 **NodeJS** 依赖并安装：

```text
axios
moment
pngjs
@jsquash/jpeg
```

使用共享 HTTP、时间或验证码工具的任务需要先安装对应依赖。

## 环境变量

NatFrp 任务可在「环境变量」中添加：

| 名称            | 示例                 | 是否必填   | 说明                                                     |
| --------------- | -------------------- | ---------- | -------------------------------------------------------- |
| `NATFRP_TOKEN`  | `your_api_token`     | 查询时必填 | NatFrp 访问密钥 / Token，多账号使用 `&` 或换行分隔       |
| `NATFRP_COOKIE` | `PHPSESSID=...; ...` | 签到时必填 | 当前官网登录会话的完整 Cookie，多账号使用 `&` 或换行分隔 |

NatFrp 的账号查询支持 Token，但签到接口只支持 SESSION。两个变量可以同时配置：脚本查询时可携带 Token，签到时只发送 Cookie，不会把 `Authorization` 头带入签到请求。`scripts/natfrp_daily_checkin.ts` 会先通过官网 CGI 检查验证要求，并在需要时使用共享的极验 3 滑块工具完成校验。

## 本地开发

本地需要 Node.js 18 或更高版本：

```bash
npm install
npm run dev:natfrp
npm run check
```

| 命令                 | 用途                                                |
| -------------------- | --------------------------------------------------- |
| `npm run dev:natfrp` | 使用 tsx 直接运行 `scripts/natfrp_daily_checkin.ts` |
| `npm run typecheck`  | TypeScript 严格类型检查                             |
| `npm test`           | 运行单元测试                                        |
| `npm run format`     | 格式化仓库                                          |
| `npm run check`      | 执行格式、类型和测试检查                            |

## 新增任务

1. 复制 `templates/task.ts.template` 为 `scripts/example.ts`。
2. 修改脚本头中的名称、说明、cron 和 `script-path`。
3. 编写业务逻辑并声明环境变量。
4. 若使用 axios 或 moment，复用 `src/core/http.ts`、`src/core/time.ts`。
5. 添加测试并执行 `npm run check`。
6. 使用 `npx tsx scripts/example.ts` 做一次直接运行验证。

不需要执行构建，也不要提交生成后的 `.js` 文件。

## 目录结构

```text
.
├─ scripts/
│  └─ natfrp_daily_checkin.ts # 青龙直接订阅和执行的任务
├─ src/core/               # 环境变量、日志、HTTP、时间和任务工具
├─ templates/              # 可执行任务模板
├─ tests/                  # 单元测试
├─ docs/                   # 订阅、开发、维护和依赖文档
├─ AGENTS.md               # 仓库维护约束
├─ package.json            # 本地工具和运行依赖清单
└─ tsconfig.json
```

详细规则：

- [订阅与导入说明](docs/subscription.md)
- [开发规范](docs/development.md)
- [维护规则](docs/maintenance.md)
- [运行时和依赖要求](docs/dependencies.md)
