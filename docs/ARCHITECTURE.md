# 架构说明

## 设计目标

Daily Workbench 把“工作区”作为核心上下文。当前工作区身份、界面偏好和收件箱已经进入 SQLite；任务、笔记、浏览器标签和终端目录会继续沿同一边界接入，业务模块不需要绕过进程隔离。

## 进程与信任边界

| 层             | 信任级别 | 职责                                        | 明确禁止                                   |
| -------------- | -------- | ------------------------------------------- | ------------------------------------------ |
| Electron Main  | 高       | 生命周期、窗口、PTY、浏览器会话、IPC 编排   | 将任意 Electron 对象直接交给页面           |
| Preload        | 高且受限 | 将窄、类型化的方法映射到 `window.workbench` | 暴露 `ipcRenderer` 或 Node.js 通用能力     |
| React Renderer | 可信 UI  | 布局、交互、状态展示、xterm 渲染            | 直接创建进程或读取本地文件                 |
| Remote Browser | 不可信   | 呈现用户访问的远程网页                      | preload、Node 集成、本地 IPC、默认设备权限 |

## 浏览器

右侧浏览器使用单独的 `WebContentsView`。React 仅绘制工具栏和占位区域，通过 `ResizeObserver` 取得内容区域的 DIP 坐标，再让 Main 更新视图边界。

- URL 只允许 `http:` 与 `https:`。
- 新窗口请求默认不创建额外 Electron 窗口；安全 URL 在当前浏览器上下文处理。
- 摄像头、麦克风、定位、通知、USB、蓝牙等权限默认拒绝。
- 使用独立的 `persist:workbench-browser` session。
- 面板关闭时隐藏视图，并在窗口销毁时显式关闭 `webContents`。
- Main 在工作台、终端或远程页面取得键盘焦点时统一拦截非重复、非 IME 组合态的 `Ctrl/Cmd + N`，并向可信 Renderer 发出快速记录事件；远程内容仍得不到本地 IPC。

## 终端

终端进程只存在于 Main：

1. Renderer 请求创建会话，并得到不可预测的会话 ID。
2. Main 选择平台默认 shell，通过 `node-pty` 启动 PTY。
3. 输出经单向事件发送给 Renderer，由 xterm.js 显示。
4. 输入和 resize 请求必须带有效会话 ID，并经过范围校验。
5. Renderer、窗口或应用退出时，Main 终止所有子进程。

Windows 默认优先使用可用的 PowerShell，后续可把 `pwsh.exe`、Windows PowerShell、CMD 与 WSL 做成显式配置。启动 PTY 时必须保留 `SystemRoot` 等系统环境变量。

## IPC 约定

共享协议放在 `src/shared`。命令使用 request/response，持续输出使用可取消订阅事件。所有 handler 都应同时验证：

- 调用者是否为可信主界面；
- 字符串长度、枚举值和数值范围；
- URL 协议、会话 ID 和边界坐标；
- 目标对象是否仍然存活。

工作区与收件箱请求必须显式带目标 `workspaceId`，Main 不能在执行时重新读取“当前工作区”猜测归属。Main 主动触发快速记录只使用固定事件通道，不暴露通用事件订阅能力。

新增功能时，应先在共享层定义输入与输出，再实现 Main handler 和 Preload 映射，最后接入 Renderer。

## 数据库

SQLite 连接、迁移、Repository 和备份都只存在于 Main。应用从 `userData` 推导固定的数据与备份目录，Renderer 不能提供路径、SQL、迁移版本或备份原因。对外只暴露健康状态、受控手动备份和备份列表。

数据库服务是应用级单例：首个窗口创建前打开，窗口关闭时保持，正常受控退出前排空操作队列并关闭。Windows 注销/关机和强制终止依靠 SQLite 事务与 WAL 做崩溃恢复，未完成的临时备份不会被列为可用备份。连接启用 foreign keys、WAL、busy timeout、defensive mode 与 `trusted_schema=OFF`，禁止加载扩展。

迁移通过构建期 raw import 嵌入 Main bundle，按连续版本在事务中执行，并把名称与 SHA-256 校验和写入历史表。已应用迁移发生漂移或数据库版本高于当前代码时拒绝启动。已有数据库升级前会先创建经过完整性验证的一致性备份；备份失败时不会继续迁移。

当前不暴露数据库恢复或删除接口。恢复需要在关闭连接后完成验证、恢复前快照、原子替换与失败回滚，后续以独立安全边界实现。详细规则见[数据库与迁移](DATABASE.md)。

## 工作区

工作区 Repository 和 Service 只使用数据库单例的同一连接，并复用关闭时等待的 FIFO 操作队列。Renderer 每次取得一个原子快照：活动工作区列表、当前工作区 ID 与当前偏好，不分别读取可能互相错位的状态。

- 新库在 Main 中生成一个默认工作区；UUID、时间戳和默认值不由 Renderer 提供。
- 创建会同时写入工作区、默认偏好和当前选择；任何一步失败都会整体回滚。
- 归档是软归档。不能归档最后一个活动工作区；归档当前项时会在同一事务中先切换到确定性的备用项。
- 当前页面、主题、侧栏、浏览器/终端面板开关和尺寸按工作区保存。
- Renderer 对偏好使用乐观显示、字段级 dirty 追踪和有序重试；工作区 mutation 返回的完整快照会按 workspace/revision 重基，不能覆盖其间已提交或待重试的偏好。
- 浏览器 URL、历史、session 与终端进程、Shell、CWD、缓冲区仍为应用级上下文；切换工作区不会销毁浏览器或 PTY，后续阶段再隔离。
- 已归档工作区的恢复和永久删除尚未暴露，数据仍会进入一致性备份。

## 快速记录与收件箱

收件箱与工作区共用同一个 SQLite 连接和 FIFO 操作队列。Renderer 取得包含 `workspaceId` 的完整活动条目快照，并按请求序号丢弃旧工作区或旧请求的迟到响应。

- 条目 ID、时间和撤销令牌只由 Main 生成；Renderer 只能提交目标工作区、正文和固定分类。
- 正文只去除首尾空白并验证良构 Unicode、控制字符和长度，不做 NFKC 改写，避免破坏 URL、代码和技术文本。
- 分类固定为未分类、任务线索、笔记和链接。“任务线索”不代表已经创建任务。
- 归档只写入 `archived_at`。成功提交后，Main 在内存中保存 15 秒有效的一次性 opaque 撤销令牌；后端有效期使用不受系统时钟回拨影响的单调时钟，令牌不能跨工作区、重复或过期使用，也不会在重启后恢复。
- 多条归档通知可以并存；切换工作区后旧响应不会写入新工作区界面。
- 工作区归档不会删除或改写其收件箱数据，但该工作区中的条目会变为只读，继续进入一致性备份。
- 未来转换为任务时，必须在单一事务中创建任务、写入唯一来源关系并归档收件箱条目；失败时整体回滚。

## 打包

Electron Forge 负责启动、原生模块 rebuild 与平台打包；Vite 分别构建 Main、Preload 和 Renderer。通过项目 npm scripts 启动或打包前，会清理明确的 `.vite` 与 `out` 目录，防止旧入口或旧安装包混入产物。`node-pty` 保持外部依赖，并由 auto-unpack-natives 从 ASAR 解包。

应用启用 Electron fuses，关闭 Node CLI 参数、`NODE_OPTIONS` 和浏览器专用 V8 snapshot 等非必要入口。Windows ConPTY 的关闭流程依赖 `child_process.fork`，因此必须保留 RunAsNode。可信 Renderer 当前通过 `file://` 加载，所以暂时显式保留该协议的额外权限；迁移到自定义 `app://` 协议后再关闭。

Electron 43 有 9 项 V1 fuse，而 Forge 7 当前兼容的 `@electron/fuses` 1.x 只能命名前 8 项。打包验证会直接断言 wire 长度和全部 9 项状态（包括 `WasmTrapHandlers`）；Electron 新增 fuse 或任一状态漂移都会使 CI 失败。Windows CI 还会对同一打包产物执行原生文件检查与终端创建、写入、关闭冒烟测试，成功后才生成校验和并上传安装制品。

原生模块不能跨系统复用。Windows 安装包必须在 Windows x64 环境执行 `npm ci` 与 `npm run make`，并在升级 Electron 或 `node-pty` 后验证打包产物中的真实终端。

完整依赖树与生产依赖采用两层门禁：生产依赖不允许任何等级的已知漏洞；Forge 尚未修复的开发期链路按 GHSA 设置有期限例外，任何新漏洞、例外过期或风险进入生产树都会阻断。详见[依赖风险说明](DEPENDENCY_RISKS.md)。

## 业务数据边界

业务 Repository 会继续放在 Main，Renderer 仍只能经 preload 使用业务 API：

```text
Workspace
├─ Inbox ✓
├─ Tasks
├─ Notes
├─ Focus sessions
├─ Browser tabs
├─ Terminal profiles
├─ Quick actions
└─ Layout state ✓
```

后续迁移、导入导出和自动备份仍需沿用同一边界，避免页面直接依赖表结构。
