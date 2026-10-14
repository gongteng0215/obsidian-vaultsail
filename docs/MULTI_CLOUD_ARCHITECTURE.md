# VaultSail: 多云架构设计（v0.1）

## 目标

- 每个本地 Obsidian Vault 显式绑定 `providerId + remoteVaultId`，本地目录名不同也可以映射同一个知识库。
- `Sync Engine` 不依赖具体云盘的 OAuth、文件路径、限流或分片上传实现。
- 首个 Provider 为百度网盘，后续依次评估 WebDAV、OneDrive、S3、Google Drive。
- 同一个 Vault 绑定一个主同步目标；“一个 Vault 同时写多个云盘”不是 MVP 范围，避免复杂的多主冲突。

## 分层

```
Obsidian UI / Settings / Commands
  └── Vault Adapter (Obsidian Vault API, iOS-compatible)
      └── Sync Engine (base snapshot + three-way planner + execution journal)
          └── CloudStorageProvider
                ├── Baidu Netdisk (implemented; real-account validation pending)
                ├── WebDAV (future)
                ├── OneDrive (future)
                ├── S3 (future)
                └── Google Drive (future)
```

## Provider 设计约束

1. 能力检测：`list/read/write/delete` 和条件写需按云端真实能力声明，不能默认所有云盘支持。
2. 云端完整枚举必须成功后才允许产出差异计划；API 失败时立即中断。
3. `mtime` 不作为唯一判等依据；内容 Hash 与已验证基线共同参与判断。
4. 写入元数据需要考虑条件更新/租约/乐观并发控制；不支持时应降级为保守冲突处理，而不是伪造互斥锁。
5. 分页、Token 刷新、重试、限流、长路径、大小写敏感度和异常码在 Provider 内处理。
6. 移动端运行时不使用 Node.js `fs`、`path`、`crypto` 或 Electron 依赖；密钥方案需跨平台验证。
7. 同步删除默认关闭，直到具备软删除、恢复、冲突副本和可靠日志。

## 核心数据设计草案

- `remoteVaultId`: 云端稳定 ID，独立于本地 Vault 名称。
- `manifest`: 相对路径、内容 Hash、大小、版本标识（不存 Token）。
- `syncBase`: 上一次**成功完成且经过校验**的双方共同状态。
- `operations`: 待执行操作清单、幂等键、状态和失败原因。
- `conflicts`: 双方副本位置、原始指纹、用户选择、处理时间。

**0.1.2 已实施授权、手动传输、版本图与实验同步。真实网盘与 iPad 尚未验收，不作为稳定同步发布。**

## 当前实施

- AuthManager 与 Provider 分开；用户使用自己的应用、每台设备独立登录。
- Provider 的 `list/read/writeImmutable/mkdir/exists` 使用获准根目录内的相对路径。完整分页工具属于通用 Provider 层。
- 云端库使用 `<实际应用目录>/vaultsail/vaults/<UUID>/vault.json + blobs/<SHA-256> + ops/<deviceId>/<opId>.json`。
- 操作以父版本建立图，缺父版本、循环、未知格式和已知事件不可见时停写；时间不决定并发胜者。
- 本地设备 ID 使用 Vault 本地存储；基线、暂存及恢复日志位于 `.vaultsail-state/<deviceId>/`。账号、应用、目录及远端库共同决定状态上下文。
- SecretStorage 保存凭据，普通设置只保存引用。最低 Obsidian 版本为 1.11.4。
- 并发重命名暂停应用并保留分支，当前不提供并发重命名自动解决。历史对象不自动清理。
