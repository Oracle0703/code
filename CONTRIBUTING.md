# Contributing

## 本地开发

1. 使用 Node.js 24 和 npm 安装依赖。
2. 从 `main` 创建主题分支。
3. 保持 Main、Preload、Renderer 的信任边界，不要从 preload 暴露通用 Electron/Node API。
4. 提交前运行 `npm run check`。

## 代码约定

- TypeScript 保持 strict 模式，不使用无说明的 `any`。
- IPC 输入必须在 Main 中运行时校验，类型声明不能替代校验。
- 远程内容必须使用独立 `WebContentsView`，不能放入可信 Renderer。
- 纯逻辑优先提取到 `src/shared` 并添加单元测试。
- 原生依赖升级必须同时验证开发模式和打包产物。

## Pull Request

PR 描述应说明变更、原因、用户影响和验证命令。界面变更请附截图；安全边界或 IPC 变更请同步更新 `docs/ARCHITECTURE.md`。
