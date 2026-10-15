# VaultSail 社区目录提交资料

仓库：`https://github.com/gongteng0215/obsidian-vaultsail`

插件 ID：`vaultsail`；名称：`VaultSail`；作者：`gongteng0215`；版本：`0.1.12`；最低 Obsidian：`1.11.4`。

短描述：Sync notes and attachments through Baidu Netdisk with version preservation and encrypted device pairing.

## 当前官方提交路径

1. 在 [Obsidian Community](https://community.obsidian.md) 使用自己的 Obsidian 账号登录。
2. 在 Profile → GitHub 关联 `gongteng0215`，让目录验证仓库所有权。命令行已有 GitHub 登录不代表社区账号已经完成关联。
3. Plugins → New plugin，填写上述仓库 URL，选择自己的维护者身份。
4. 用户阅读并接受 Developer policies，以及继续维护、无法维护时移除或转让的承诺，然后提交。
5. 查看自动审核结果，处理问题；审核通过前不会在 Obsidian 内供用户安装。

依据：[提交指南](https://docs.obsidian.md/plugins/releasing/submit-plugin)、[登录及关联账号](https://docs.obsidian.md/community-directory/set-up-and-claim)、[插件提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)、[开发者政策](https://docs.obsidian.md/community-directory/developer-policies)。现在无需向旧 obsidian-releases 仓库提交列表 PR。

## 已准备与验证边界

- 公共仓库有 README、MIT LICENSE、简明 manifest、版本映射和锁文件。
- 使用跨平台 Obsidian 网络/文件 API 与 Web Crypto，不在运行时代码导入 Node.js/Electron 模块。
- 安装包只包含 main.js、manifest.json、styles.css；独立附件应发布到版本同名的 GitHub Release。
- README 披露账号要求、百度网络服务、密钥存储、配对的权限含义、笔记尚未加密和实际设备验证边界。
- 自动化测试和构建需要在冻结的发布提交通过。旧包与临时产物清理不删除测试源码、Git 恢复包、安装恢复备份或用户配置。
- 真实 iPad、真实 100 文件跨端、长期共享令牌续期仍未由开发者验收；不能在提交时声明已实测通过，也不能保证审核通过。
