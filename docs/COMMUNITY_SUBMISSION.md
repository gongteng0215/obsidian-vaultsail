# VaultSail 社区目录提交资料

当前发布目标：**0.2.14**，最低 Obsidian **1.11.4**。本次合并 0.2.6–0.2.14 本地预览的功能与修复，217 项自动化测试通过，配置、授权和云端格式兼容。浏览器交互验证与真实 Obsidian/iPad 验收分开记录。GitHub 发布、附件校验和本轮社区审核状态以实际发布结果为准。

## 早期提交与审核记录

以下保留历史版本的原始状态，不表示当前社区版本。

**当前状态：社区条目已恢复，0.1.17 自动检查 Completed。** 2026-10-15 发布账号迁移与云端库绑定分离修复，提交 `85ca3b3` 通过 92 项测试、构建、ZIP 校验及 CI；五份公开附件已重新下载并逐一核对 Hash。官方检查无阻断错误，依赖无漏洞，main.js 从源码逐字节复现。社区当前版本为 0.1.17；仍有非阻断警告和建议。应用内搜索清单的同步与审核分别判断，不以审核完成代替搜索可用性验证。此前 0.1.16 恢复发布、归档和审核过程保留为历史记录。

仓库：`https://github.com/gongteng0215/obsidian-vaultsail`

插件 ID：`vaultsail`；名称：`VaultSail`；作者：`gongteng0215`；本次提交版本：`0.1.17`；最低 Obsidian：`1.11.4`。

短描述：Sync notes and attachments through Baidu Netdisk with version preservation and encrypted device pairing.

2026-10-15 已在维护者确认政策后提交并发布 [社区条目](https://community.obsidian.md/plugins/vaultsail)。初次 0.1.12 审核发现设置标题必须使用官方 Setting 接口，目录安装暂未开放；构建已被官方逐字节复现通过。0.1.13 修复标题组件，补齐英文 README，以及文件枚举和只写剪贴板行为的说明，供后续审核读取。提交不等于审核通过，最终安装状态以官方页面为准。

GitHub 0.1.12 已公开，独立插件文件/ZIP 已下载与本地校验一致，云端构建 main.js 也与发布文件一致。0.1.1 D0 旧测试发布撤回到草稿，保留恢复能力；18 项旧本地产物移入 dist 下的可恢复归档，测试代码和用户配置保留。

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

0.1.13 第二轮检查要求功能标题不包含插件名称，构建再次通过官方逐字节复现。0.1.14 保留独立品牌展示，标题改为功能名称，继续审核。

公开版本映射仅保留有公开安装资产的 0.1.12 及之后版本，不让旧版 Obsidian 回退到已撤回 D0 或从未公开的本地候选包。当前最低支持版本始终为 1.11.4。

最终结果：0.1.14 / `966e46f` 官方检查 Completed，未发现阻断错误；无漏洞依赖及发布构建逐字节复现通过。公开页面显示当前 0.1.14，Add to Obsidian 已变为有效的 `obsidian://show-plugin?id=vaultsail` 链接。Scorecard 仍显示 Caution，保留代码风格、弹出窗口计时器、旧版设置 API、证明资产来源等非阻断建议，不宣称零警告。官方自动检查也不代替真实 iPad 验收。
