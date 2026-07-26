# 依赖风险说明

## 门禁策略

CI 分开检查两类风险：

1. `npm run audit:prod` 要求生产依赖在所有严重等级均为 0。
2. `npm run audit:all` 保存完整 JSON 报告，并只允许 `config/audit-allowlist.json` 中尚未到期、仍为开发依赖的根 advisory。

例外按 GHSA 管理，而不是按 npm 展开的受影响包数量管理。已修复的 advisory 可以自然消失；新增 advisory、根包变化、例外到期或任一相关节点不再标记为 `dev` 都会使检查失败。CI 会把完整报告作为 30 天制品保存，并把摘要写入 Job Summary。

两个门禁都通过固定 npm 11.9.0 的独立审计子进程运行。该子进程只为 npm 官方
`POST /-/npm/v1/security/advisories/bulk` 安装严格限域的响应兼容：仅当最终响应仍为
官方 HTTPS URL、状态为 200 且真正缺失 `Content-Encoding` 时，才从无损 clone 检查前三个
wire bytes；普通 JSON 仍交回 npm 原生解析。只有完整 gzip 魔数命中后，兼容层才在固定
输入/输出/时间上限内验证单一 gzip member、CRC32、ISIZE、UTF-8、JSON 和请求包名子集。
任何其他 host、method、path、query 或编码完全沿用 npm 行为；版本漂移、模块挂接失败、
损坏或超限数据仍会关闭门禁。兼容层不重试、不生成 advisory、不修改 npm 的 0/1 退出语义，
也不改变下述 allowlist。

## 当前受控风险

最早复查期限：2026-08-31。每项风险的独立期限如下；任一到期都会由完整依赖审计阻止构建。

| 依赖路径                                                                                                      | 影响范围                                              | 缓解措施                                                                                                                                         | 复查期限   |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| Forge / ESLint / TypeScript → 多个 `minimatch` 主版本 → `brace-expansion` 1.1.16 / 2.1.2 / 5.0.7              | 仅质量检查、依赖处理和打包时展开 glob；不进入生产依赖 | 锁文件中的全部节点均为 dev-only；应用不把用户内容作为构建 glob；生产审计独立归零；等待各 minimatch 依赖范围获得兼容修复                          | 2026-08-31 |
| Electron Forge → `@electron/rebuild` 3.x → `tar` 6.2.1（rebuild 直接、Electron node-gyp 与 cacache 三路共用） | 仅安装/打包时处理依赖与头文件，不进入应用运行依赖     | 锁文件固定 npm 包、Node 官方发行文件及 Electron 官方 GitHub commit；不处理用户提供的归档或成员筛选；生产审计独立归零；等待 Forge 升级 rebuild 链 | 2026-10-31 |
| Forge CLI → Inquirer → external-editor → `tmp` 0.0.33                                                         | 仅 Forge 的交互式开发 CLI；应用不调用                 | CI 使用非交互命令；生产包不包含该链；等待上游升级                                                                                                | 2026-10-31 |

精确 GHSA 列表保存在机器可校验的 `config/audit-allowlist.json` 中。

2026-07-25 的新增复查包含 `brace-expansion` 的 `GHSA-MH99-V99M-4GVG` 与 `tar` 的
`GHSA-R292-9MHP-454M`。当时 `npm audit` 对两项都报告 `fixAvailable: false`。前者虽有
`brace-expansion` 5.0.8，但现有 minimatch 消费者分别把它约束在 `^1.1.7`、
`^2.0.1` / `^2.0.2` 与 `^5.0.5`；后者则由 `@electron/rebuild`、Electron node-gyp 和
cacache 三路共用同一个 `tar` 6.2.1，而 Forge 7.11.2 声明的 rebuild 3.x 范围不能解析到
修复链。只有对应 GHSA 已从审计报告消失，且所有相关节点都自然解析到修复版本后，才能删除
例外；若需要升级上游主版本，还必须在独立变更中完成 Linux package 与 Windows
Squirrel/ConPTY 冒烟。

## 明确不采用的处理方式

- 不运行 `npm audit fix --force`。
- 不把 `brace-expansion`、`tar`、`tmp` 或 `@electron/rebuild` 强制覆盖到超出上游声明范围的主版本。
- 不为了让数字归零而降低 Forge 版本。

这些方式会改变 Windows 原生模块重建链，可能产生“审计变绿但安装后的终端不可用”的结果。上游发布兼容版本后，应删除对应例外并重新执行 Linux package、Windows Squirrel make 和打包后 ConPTY 冒烟测试。

## Fuse 兼容性记录

Forge 7.11.2 的 fuse 插件要求 `@electron/fuses` 1.x；直接升级 2.x 会违反 peer 范围。Electron 43 的第 9 项 fuse 暂由 `scripts/verify-packaged-app.mjs` 按原始 wire 索引校验，状态固定为启用。等待 Forge 支持 fuses 2.x 后，再迁移到具名配置和 `strictlyRequireAllFuses`。
