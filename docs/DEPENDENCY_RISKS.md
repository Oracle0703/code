# 依赖风险说明

## 门禁策略

CI 分开检查两类风险：

1. `npm run audit:prod` 要求生产依赖在所有严重等级均为 0。
2. `npm run audit:all` 保存完整 JSON 报告，并只允许 `config/audit-allowlist.json` 中尚未到期、仍为开发依赖的根 advisory。

例外按 GHSA 管理，而不是按 npm 展开的受影响包数量管理。已修复的 advisory 可以自然消失；新增 advisory、根包变化、例外到期或任一相关节点不再标记为 `dev` 都会使检查失败。CI 会把完整报告作为 30 天制品保存，并把摘要写入 Job Summary。

## 当前受控风险

复查期限：2026-10-31。

| 依赖路径                                                                   | 影响范围                                          | 缓解措施                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Electron Forge → `@electron/rebuild` 3.x → Electron node-gyp → `tar` 6.2.1 | 仅安装/打包时处理依赖与头文件，不进入应用运行依赖 | 锁文件固定 npm 包、Node 官方发行文件及 Electron 官方 GitHub commit；生产审计独立归零；等待 Forge 升级 rebuild 链 |
| Forge CLI → Inquirer → external-editor → `tmp` 0.0.33                      | 仅 Forge 的交互式开发 CLI；应用不调用             | CI 使用非交互命令；生产包不包含该链；等待上游升级                                                                |

精确 GHSA 列表保存在机器可校验的 `config/audit-allowlist.json` 中。

## 明确不采用的处理方式

- 不运行 `npm audit fix --force`。
- 不把 `tar`、`tmp` 或 `@electron/rebuild` 强制覆盖到超出上游声明范围的主版本。
- 不为了让数字归零而降低 Forge 版本。

这些方式会改变 Windows 原生模块重建链，可能产生“审计变绿但安装后的终端不可用”的结果。上游发布兼容版本后，应删除对应例外并重新执行 Linux package、Windows Squirrel make 和打包后 ConPTY 冒烟测试。

## Fuse 兼容性记录

Forge 7.11.2 的 fuse 插件要求 `@electron/fuses` 1.x；直接升级 2.x 会违反 peer 范围。Electron 43 的第 9 项 fuse 暂由 `scripts/verify-packaged-app.mjs` 按原始 wire 索引校验，状态固定为启用。等待 Forge 支持 fuses 2.x 后，再迁移到具名配置和 `strictlyRequireAllFuses`。
