# 架构说明

## 设计目标

Daily Workbench 把“工作区”作为核心上下文。任务、笔记、浏览器标签、终端目录和布局状态最终都归属于一个工作区。当前 `v0.1` 先建立进程隔离和 UI 外壳，后续业务模块无需绕过安全边界即可扩展。

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

新增功能时，应先在共享层定义输入与输出，再实现 Main handler 和 Preload 映射，最后接入 Renderer。

## 打包

Electron Forge 负责启动、原生模块 rebuild 与平台打包；Vite 分别构建 Main、Preload 和 Renderer。`node-pty` 保持外部依赖，并由 auto-unpack-natives 从 ASAR 解包。应用同时启用 Electron fuses，关闭 Node CLI 参数和 `NODE_OPTIONS` 等非必要入口。Windows ConPTY 的关闭流程依赖 `child_process.fork`，因此保留 RunAsNode；Windows CI 会对打包后的终端执行创建、写入和关闭冒烟测试。

原生模块不能跨系统复用。Windows 安装包必须在 Windows x64 环境执行 `npm ci` 与 `npm run make`，并在升级 Electron 或 `node-pty` 后验证打包产物中的真实终端。

## 下一阶段的数据边界

计划在 Main 内新增 SQLite repository 层，Renderer 仍只能经 preload 使用业务 API：

```text
Workspace
├─ Tasks
├─ Notes
├─ Focus sessions
├─ Browser tabs
├─ Terminal profiles
├─ Quick actions
└─ Layout state
```

数据库迁移、导入导出和自动备份应一起落地，避免页面直接依赖表结构。
