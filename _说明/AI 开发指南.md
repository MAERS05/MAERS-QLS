# AI 开发指南

本文件回答“怎样快速了解项目并完成一次可验证的修改”。开发约束统一见[开发规范](开发规范.md)，这里不重复定义。

## 建立上下文

1. 从 [README](../README.md) 了解产品用途、运行环境与用户操作边界。
2. 阅读[开发规范](开发规范.md)，再通过[文件功能说明](文件功能说明.md)定位当前任务涉及的页面、服务和测试。
3. 涉及界面或模块依赖时读[前端开发指南](前端开发指南.md)；涉及保存、备份或恢复时读[数据保障与存储迁移](数据保障与存储迁移.md)。
4. 遇到跨日计时、并行统计、重复日程、连续保存或 PWA 行为，再读[细节设计说明](细节设计说明.md)。需要理解选型原因时查[架构决策记录](架构决策记录.md)。

不必每轮通读所有文件；先理解任务所在的一条完整链路。

## 修改前

在项目根目录检查工作区：

```powershell
git status --short
git diff --stat
rg --files -g '!node_modules' -g '!dist'
```

分清已有修改与本轮新增内容。代码定位优先使用 `rg`，沿 `import` 查依赖并阅读相关测试，不从旧全局接口名猜测实现位置。

几个常见入口：

| 任务 | 起点 |
| --- | --- |
| 修改规划表 | `MAERS-Schedule/js/timeblock.js` 与 `timeblock-editor.js` |
| 修改任务弹窗或切换视图 | `MAERS-Schedule/js/app.js` |
| 修改计时或入账 | `timer-service.js` → `common/js/storage/day-sync.js` → `common/js/timer-events.js` |
| 修改记录页保存 | `MAERS-QuantiLife/js/app.js` → `records.js` → `common/js/day-record.js` |
| 修改报告 | `report.js` → `report-aggregator.js`，排行另看 `time-stats.js / rank-view.js` |
| 修改备份 | 两个子系统的 `data-transfer.js`、`common/js/portal.js` 和 `storage/import.js` |

上表中的简称以[文件功能说明](文件功能说明.md)提供的目录上下文为准。

## 修改与验证

先确定状态由谁拥有、写入经哪个入口、界面如何得知结果，再做最小完整修改。新增代码先复用职责模块；运行时使用 `import` 的具名服务，兼容 `window` 接口只用于调试或现有外部调用。

验证范围按[开发规范](开发规范.md)选择。针对一个行为运行已有测试的例子：

```powershell
node --test --test-isolation=none tests/unit/schedule-consistency.test.js
node --test --test-isolation=none tests/integration/schedule.test.js
node --test --test-isolation=none tests/static/contracts.test.js
```

`createPage()` 会执行实际页面入口的模块图；默认没有 IndexedDB，使用兼容后端。测试主存储路径时传入 `createIdbFactory()`，跨页测试让两个页面共享同一工厂，并等待 `page.ready()`。代码位置见 [dom.js](../tests/helpers/dom.js) 和 [modules.js](../tests/helpers/modules.js)。浏览器原生模块装载、Web Locks、Service Worker 等能力最终由 E2E 验证。

数据功能的验证要覆盖实际失败方式，例如冲突后重试、跨日删除后的旧记录清理、导入后缓存刷新；仅验证函数返回值不足以说明已落盘。数据故障的排查顺序见[数据保障与存储迁移](数据保障与存储迁移.md)。

运行时资源变化时，验证前更新预缓存；仅修改说明文档时检查文档引用和已有静态契约即可。不要为写文档运行桌面构建，它会生成启动器、图标并复制启动器到系统桌面。

## 交付信息

说明实现了什么、主要修改在哪里、实际运行了哪些验证以及剩余限制。测试跳过、工具不可用、未执行发布时如实区分；不把构建成功写成部署成功。同步更新对应说明文档和[项目更新日志](项目更新日志.md)，保留可核实的变更依据。

文档中的代码片段是用法示例，源码和测试才是检查实际行为的入口；发现不一致时一并修正文档。
