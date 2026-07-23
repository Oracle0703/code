# Contributing

## 本地开发

1. 使用 `.nvmrc` 中固定的 Node.js 24.14.0 和 npm 11.9.0。
2. 从 `main` 创建主题分支。
3. 保持 Main、Preload、Renderer 的信任边界，不要从 preload 暴露通用 Electron/Node API。
4. 使用 `npm ci` 从锁文件安装，并在提交前运行 `npm run check`。

## 代码约定

- TypeScript 保持 strict 模式，不使用无说明的 `any`。
- IPC 输入必须在 Main 中运行时校验，类型声明不能替代校验。
- 远程内容必须使用独立 `WebContentsView`，不能放入可信 Renderer。
- 纯逻辑优先提取到 `src/shared` 并添加单元测试。
- 原生依赖升级必须同时验证开发模式和打包产物。
- 依赖改动必须提交同步生成的 `package-lock.json`，不能手工编辑锁文件。
- 不使用 `npm audit fix --force` 或跨主版本 override 掩盖构建链漏洞。
- 审计例外必须绑定 GHSA、限定为开发依赖并设置复查期限；新增或过期例外需要明确评审。

## 数据库迁移

- 迁移放在 `migrations/`，版本必须连续且只允许追加。
- 已进入 `main` 的迁移不能修改、重命名、重排或删除；结构调整必须新增下一版本迁移。
- SQL 必须能在当前 `.nvmrc` Node 与 Electron 内置 SQLite 两种运行时中执行。
- 迁移 SQL 不能包含事务控制、保存点、`PRAGMA` 或 `ATTACH/DETACH`；这些状态由迁移框架统一管理。
- 新迁移必须覆盖新库、已有库升级、重复打开和失败回滚测试。
- Renderer 和 Preload 不能读取迁移文件、数据库路径或直接执行 SQL。
- 数据导入或恢复必须先创建备份，并在独立 PR 中说明失败回滚方案。
- 工作区写操作必须复用数据库单例和操作队列；不能为业务 Repository 另开 SQLite 连接。
- 工作区偏好使用字段 patch，拖拽尺寸只在结束时写入；浏览器/终端进程不能因切换工作区而被重新挂载。
- 收件箱请求必须显式携带目标工作区；正文不得做破坏原文的兼容归一化，分类不得伪装成已完成的任务/笔记转换。
- 业务软归档的撤销必须绑定一次具体操作，不能让 Renderer 传任意历史状态覆盖当前数据。
- 任务请求必须显式携带目标工作区；Renderer 不能提供任务 ID、持久化日期、时间戳、完成时间或收件箱来源关系。
- 收件箱转换必须在同一事务中创建任务、建立唯一来源并归档条目；重复转换或任一步失败不能留下部分写入。
- Today 计划只接受 `today`/`none` 意图，由 Main 生成本地民用日期；测试不能依赖 runner 的 locale 或当前系统日期。
- 新业务迁移必须同时扩展普通 Node 的旧版本升级矩阵和 Linux/Windows 打包后 Electron 冒烟，并验证对应 schema 版本的备份内容。

## Pull Request

PR 描述应说明范围、非范围、验收标准、变更原因、用户影响、迁移/回滚方式和验证命令。界面变更请附截图；安全边界或 IPC 变更请同步更新 `docs/ARCHITECTURE.md`。
