# MAERS QLS

**量化生活，规划时间。** MAERS QLS 将 Schedule 时间管理和 QuantiLife 生活量化整合在同一套本地数据与界面基础上，适合希望安排计划、记录实际投入并回顾生活趋势的个人用户。

| 入口 | 功能 |
| --- | --- |
| [门户](index.html) | 进入子系统、配置默认入口、导入导出业务备份 |
| [Schedule](MAERS-Schedule/index.html) | 周历规划表、短中长期任务、进行中多任务分段计时 |
| [QuantiLife 记录](MAERS-QuantiLife/index.html) | 步数、睡眠、饮水、饮食、时间与心情记录，设定期望 |
| [QuantiLife 报告](MAERS-QuantiLife/report.html) | 趋势、分类/标签排行、单一与并行事项分析 |

纯前端、运行时零第三方依赖，无需业务服务器或账户。支持 PWA 安装与离线使用，主要数据保存在浏览器 IndexedDB 中；也提供 Windows 桌面启动器。

> 请一次只在一个标签页编辑。保存后，先处理其他页面的未保存内容，再刷新继续操作。数据按浏览器配置和访问源隔离；固定使用相同访问地址，更换设备、地址或清理浏览器数据前导出业务备份。项目不提供云端同步。

## 启动

开发环境需要 Node.js ≥ 22。浏览器使用支持原生 ES 模块、IndexedDB 和原生 dialog 的现代版本；真实浏览器测试使用本机 Chrome 或 Edge。

在项目根目录执行：

```powershell
npm ci
npm start
```

默认只监听本机，起始端口为 8081，会打开浏览器；以启动日志给出的地址为准。`npm start` 先刷新预缓存清单。开发依赖用于检查和测试，浏览器运行时无需它们。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 改为 `0.0.0.0` 可供局域网设备访问 |
| `PORT` | `8081` | 配置起始端口；已有 QLS 服务时复用，其他程序占用时顺延 |

PowerShell 配置示例：

```powershell
$env:HOST = '0.0.0.0'
$env:PORT = '3000'
npm start
```

变量影响当前终端及其子进程；用完可关闭终端。端口改变也会改变浏览器数据所属的访问源。

## 命令与验证

命令定义见 [package.json](package.json)，检查范围和覆盖率要求统一见[开发规范](<_说明/开发规范.md>)。

| 命令 | 用途 |
| --- | --- |
| `npm start` | 经 [scripts/dev-server.js](scripts/dev-server.js) 启动本地静态服务 |
| `npm run lint` | ESLint 检查 |
| `npm test` | 单元、页面集成和静态契约测试，自动预更新缓存清单 |
| `npm run test:coverage` | 全量测试与逐文件覆盖率门槛检查 |
| `npm run test:e2e` | 真实浏览器测试；无可用浏览器时跳过，需留意实际结果 |
| `npm run build:precache` | 由运行时资源生成 [precache-manifest.js](precache-manifest.js)，无需手改 |
| `npm run build` | 生成仅包含运行时资源的 `dist/` |
| `npm run build:exe` | 通过 [scripts/build-desktop-app.js](scripts/build-desktop-app.js) 生成 `MAERS-QLS.exe` 和 [common/ui/icon.ico](common/ui/icon.ico)，并将启动器复制到系统桌面 |

可用 `E2E_CHANNEL=chrome` 或 `msedge` 指定测试浏览器；PowerShell 中按上述环境变量方式设置。

## 安装和发布

- **PWA**：通过本机 HTTP 或线上 HTTPS 访问，浏览器支持时选择“安装应用 / 添加到主屏幕”。首次完整缓存完成后才具备离线打开能力。
- **Windows 启动器**：已有 `MAERS-QLS.exe` 时可双击启动。运行依赖本机 Node.js、Chrome/Edge 和项目文件；它不是将项目及 Node 打包进单个可移植 exe。构建会调用 Windows .NET C# 编译器生成窗口启动器。
- **静态部署**：运行 `npm run build` 后发布 `dist/` 内容，不上传整个仓库。当前 [vercel.json](vercel.json) 已配置该构建命令和输出目录；其他静态主机需提供正确的 JS MIME 类型并保持相对路径。线上 HTTPS 用于 PWA/Service Worker。

桌面窗口关闭时启动器会停止其后台服务，重复启动会尝试唤醒既有窗口。源文件在本仓库中维护，`dist/` 与启动器均为构建产物。

## 文档导航

根目录仅保留本 README，其余说明集中在既有 `_说明/` 目录。每份文档回答一个问题；开发约束只在开发规范中定义。

| 文档 | 回答的问题 |
| --- | --- |
| [开发规范](<_说明/开发规范.md>) | 必须遵守哪些模块、数据、界面和验证规则？ |
| [AI 开发指南](<_说明/AI 开发指南.md>) | AI 应按什么顺序了解项目、修改和验证？ |
| [文件功能说明](<_说明/文件功能说明.md>) | 功能在哪里实现，入口和依赖是什么？ |
| [前端开发指南](<_说明/前端开发指南.md>) | 页面、视图、领域服务与存储如何协作，功能怎样接入？ |
| [架构决策记录](<_说明/架构决策记录.md>) | 为什么采用当前方案，有哪些代价和替代方案？ |
| [数据保障与存储迁移](<_说明/数据保障与存储迁移.md>) | 数据真源、结构、提交、备份、迁移和故障恢复是什么？ |
| [细节设计说明](<_说明/细节设计说明.md>) | 跨日并行、重复日程、连续保存和离线更新如何工作？ |
| [项目更新日志](<_说明/项目更新日志.md>) | 已完成哪些变更，影响是什么、依据在哪里？ |

第一次维护可按“README → 开发规范 → 文件功能说明 → 当前任务对应指南”的顺序阅读。

源码导航起点：[common/js/core.js](common/js/core.js) 提供公共元数据，[tests/helpers/dom.js](tests/helpers/dom.js) 提供页面测试装载；完整职责和测试导航见文件功能说明。项目目前只有前端，不单设后端开发指南。

## 开源协议

本项目基于 [GNU General Public License v3.0](LICENSE) (GPL-3.0-or-later) 协议开源。
