# VaultSail · 云舟

Sync notes and attachments through Baidu Netdisk with version preservation and password-encrypted device pairing.

让同一个云端知识库连接你的多台设备。电脑完成百度授权后，可以通过加密配对码把连接带到另一台设备；笔记直接传到你自己的百度网盘。

## 功能

- 一键双向同步，也可以先预览上传、下载或同步清单。
- 根据已验证基线判断文件变化；并发编辑自动保留双方内容和可见冲突副本。
- SHA-256 内容校验、不可变版本记录、未完成任务恢复及本地恢复副本。
- 密码加密配对码或文件，迁移应用密钥与授权。导入后自动校验账号、云端库及本设备的小文件上传下载权限。
- 显示同步阶段、耗时、最近完成记录和云端版本对应的存放位置。
- 删除同步默认关闭，Obsidian 配置及插件内部目录默认排除。

目前支持百度网盘，单文件最大 20 MiB，传输并发为 1。同步由用户手动触发，不提供正文自动合并或持续移动后台同步。配对配置经过加密；云端笔记内容尚未端到端加密。

## 安装

需要 Obsidian **1.11.4 或更新版本**。

社区目录审核通过后可在 Obsidian 的第三方插件页面搜索 **VaultSail** 安装。目前可以从 [GitHub Releases](https://github.com/gongteng0215/obsidian-vaultsail/releases/latest) 下载安装包，将 `main.js`、`manifest.json`、`styles.css` 放入当前知识库配置目录的 `plugins/vaultsail/`，然后启用插件。默认配置目录为 `.obsidian`，也支持自定义目录。

## 首台设备

1. 使用自己的百度账号和百度开放平台应用，获取 AppKey 与 SecretKey。百度账号负责登录，开放平台应用负责取得接口权限。
2. 在「连接与授权」保存 AppKey 和 SecretKey，并设置实际获准的 `/apps/应用名` 目录。默认目录 `/apps/VaultSail` 不代表已取得该目录权限。
3. 点击「连接百度网盘」，在百度官方页面完成登录授权。
4. 创建云端库或绑定已有库，并检查文件传输权限。
5. 点击「开始同步」，或者先预览变化。

云端保存 `vault.json + blobs + ops` 内容与版本记录。它是插件管理的版本存储，下载后还原普通笔记目录；不是其他网盘文件的直接镜像。详细步骤见 [使用说明](docs/USER_SETUP.md)。

## 把连接带到 iPad

电脑点击「导出配对配置」，设置配对密码并生成加密配对码。在另一设备的同版插件中导入配对码及密码，自动验证通过后即可同步，无需重复网页登录。配对码 24 小时内可导入；设备身份、同步基线和任务队列保持独立。旧版 JSON 不含授权，仍需独立登录。见 [配对说明](docs/PAIRING.md)。

授权被平台撤销或刷新令牌失效时，需要从仍连接的设备重新导出，必要时重新授权。真实 iPad 加解密、密钥存储、双设备长期续期与大规模真实跨端验证尚未完成；不把自动化模拟结果作为实机认证。

## 账号、网络与隐私

**Accounts and network access are required.** Users supply their own Baidu account and approved application credentials. The plugin connects directly to Baidu OAuth (`openapi.baidu.com`), file APIs (`pan.baidu.com`, `d.pcs.baidu.com`) and official HTTPS download hosts under `baidu.com`/`baidupcs.com` to authorize, list, upload and download files. Links to Baidu application and authorization management pages open only after a user action.

没有开发者授权服务器，不要求把账号密码、SecretKey 或令牌交给开发者。凭据保存在 Obsidian SecretStorage，插件设置只存引用。无广告、遥测、自更新或知识库外文件访问；脱敏诊断不含凭据、文件名及笔记正文。配对码和密码一起持有者可以使用其中的授权，请只交给自己的设备。

## 开发与验证

需要 Node.js 22+。执行 `npm ci`、`npm test`、`npm run build`，再运行 `pwsh ./scripts/package-release.ps1` 生成安装包。发布包只包含三个插件文件，不包含测试代码、用户配置、密钥或笔记。

当前 86 项自动化测试覆盖授权、加密配对、文件接口、分页、并发冲突、恢复、路径安全与配置隐私。实际设备验证状态见 [实施记录](docs/IMPLEMENTATION_STATUS.md)，性能对比见 [性能记录](docs/PERFORMANCE.md)。

## 许可与反馈

[MIT](LICENSE)。运行时依赖 `@noble/hashes`（MIT）；相关许可见 [第三方许可](THIRD_PARTY_NOTICES.md)。通过 [GitHub Issues](https://github.com/gongteng0215/obsidian-vaultsail/issues) 提交问题，请不要附带真实配对码、密码或授权令牌。
