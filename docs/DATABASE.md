# 数据库与迁移

Daily Workbench 使用 Electron 自带的 `node:sqlite`。数据库只在 Main 进程中打开；Renderer 不能接触 SQL、数据库文件路径或任意备份目标。

## 目录与生命周期

Main 从 `app.getPath('userData')` 推导受控的数据目录：

```text
userData/
└─ data/
   ├─ daily-workbench.sqlite3
   └─ backups/
      └─ daily-workbench-*.sqlite3
```

在 POSIX 系统上，应用会把既有或新建的 `data/` 与 `backups/` 目录收紧为仅当前用户可访问的 `0700`，数据库与已完成备份使用 `0600`。Windows 依赖用户配置目录的系统 ACL；当前阶段不自行重写 ACL。

数据库服务是应用级单例，在第一个窗口创建前打开。macOS 上关闭并重新打开窗口不会重复创建连接；正常受控退出时会停止接收新操作、等待正在进行的备份结束，再 checkpoint WAL 并关闭连接。Windows 注销、关机或进程被强制终止时不能依赖 Electron 的退出事件，此时由 SQLite 事务/WAL 保证崩溃恢复，未完成的 `.partial` 备份不会进入可用备份列表。

所有页面只能调用以下窄接口：

- 获取数据库健康状态；
- 在应用控制的目录中创建手动备份；
- 列出由应用生成的最近备份。

接口不接受路径、SQL、迁移版本或备份原因。恢复、导入、删除备份不属于当前阶段。

## 连接策略

数据库适配层统一启用以下约束：

- foreign keys；
- WAL journal；
- `synchronous=NORMAL`；
- 5000ms busy timeout；
- `trusted_schema=OFF`；
- defensive mode；
- 禁止扩展加载与双引号字符串兼容行为。

Repository 负责 SQL 与行映射，Service 负责生命周期、串行化、迁移、备份和对外返回值。业务页面后续只能通过 `Renderer → Preload → 可信 IPC → Service → Repository` 接入。

## 迁移规则

迁移源文件放在 `migrations/`，通过 `?raw` 在构建时嵌入 Main bundle，避免安装后依赖源码目录。

1. 版本必须从 1 开始连续递增。
2. 已合并或发布的迁移禁止修改、重排或删除，只能追加新文件。
3. 每条已应用迁移记录版本、名称、SHA-256 校验和与应用时间。
4. 启动时会比较代码中的迁移与数据库历史；缺号、未知版本、名称或校验和漂移都会阻止打开。
5. 待执行迁移在 `BEGIN IMMEDIATE` 事务内应用；任何错误都会回滚本次启动中的全部待执行迁移。
6. 迁移 SQL 禁止自行提交、开启保存点、执行 `PRAGMA` 或 `ATTACH/DETACH` 外部数据库；事务、版本、连接安全设置和数据库路径只由迁移框架控制。
7. 迁移成功后必须通过 quick check、foreign-key check，并重新核对 WAL、foreign keys、`synchronous=NORMAL`、5000ms busy timeout 与 `trusted_schema=OFF`。

已有数据库需要升级时，应用会先生成 `pre-migration` 一致性备份；备份创建或校验失败时不会执行迁移。新建空数据库不会生成无意义的迁移前备份。

## 备份与未来恢复

备份使用 SQLite online backup API 写入同目录的唯一临时文件，验证快照可只读打开且完整后，再原子重命名为最终文件。列表会忽略临时文件、旁路文件和符号链接；Renderer 得到的是序列化元数据，不是绝对路径。

当前版本不会自动删除备份，也不会提供恢复 IPC。未来恢复功能必须在独立变更中完成以下保护：

1. 只接受列表中的 opaque ID，不接受任意路径；
2. 校验应用标识、迁移历史、schema 版本、quick check 与 foreign-key check；
3. 替换前自动创建恢复前快照；
4. 关闭连接并在重启阶段原子替换数据库；
5. 使用 crash marker，在重新打开或迁移失败时自动回滚。

## 验证矩阵

- 普通 Node 测试：新建、重开幂等、迁移回滚、校验和漂移、路径边界、备份一致性和关闭队列。
- Linux 打包测试：真实 Electron 可执行文件中的 `node:sqlite`、WAL、迁移、备份和重开。
- Windows 打包测试：同一数据库冒烟链路在 Squirrel 产物对应的 Electron/SQLite 运行时中通过。

开发机 Node 与 Electron 内置 Node/SQLite 的小版本并不完全相同，因此普通单元测试不能替代打包后冒烟测试。
