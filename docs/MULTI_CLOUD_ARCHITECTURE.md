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
                ├── Baidu Netdisk (D0 validation, not implemented)
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

**当前仓库只是架构骨架，不具备真实同步能力。**
