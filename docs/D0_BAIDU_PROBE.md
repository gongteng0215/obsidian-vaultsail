# D0：百度网盘 API 只读联通性验证

> 本文保留 0.1.1 的历史只读探测说明。0.1.2 的设置页已改为自己的应用配置与 OAuth，当前操作请使用 [USER_SETUP.md](USER_SETUP.md)；开发机只读脚本仍可使用。

> 状态：实现了本地只读探测代码，**尚未取得用户授权或对真实网盘进行联通验证**。
> 不要将 access token、refresh token、App Secret、私人网盘文件名等提交到仓库或聊天。

## 背景及验证边界

百度开放平台已发生平台整合升级，历史 API 文档中的端点仅可视为待验证候选。必须以当前应用实际获得的权限和响应为准。本检查阶段不支持上传、下载、删除，不扫描真实笔记；只获取可达性及一个隔离的应用目录的文件数量。

- 官方平台：https://yun.baidu.com/union
- 平台升级说明：https://yun.baidu.com/open/platform
- 历史接口候选：`GET /rest/2.0/xpan/nas?method=uinfo` 和 `GET /rest/2.0/xpan/file?method=list`。正式接入前必须在开发者后台确认仍可使用。
- Windows/iPad 插件网络实现后续使用 Obsidian `requestUrl()`；本次 `node fetch()` 仅用于开发机上的 D0 检查，插件设置页使用 Obsidian `requestUrl()` 复用同一套只读验证逻辑。

## 准备

1. 使用自己的百度开放平台应用申请必要的官方权限，并按平台目前的正式授权流程获得短期 `access_token`。**不要使用第三方应用泄漏出来的密钥或绕过授权流程。**
2. 建立只含测试文件的应用专属目录，例如 `/apps/VaultSail`；具体可用目录名称以开发者后台实际授权为准。
3. 当前脚本仅读取、不会自动创建目录；目标目录不存在时将失败，不视为“空目录”。

## 在 Obsidian 插件内测试（Windows/iPad）

在 **VaultSail → 设置**，将短期的合法 `access_token` 填入 *D0: temporary Baidu access token*，并确认测试目录，然后点击 **Check access**。该按钮调用 Obsidian `requestUrl()`，仅获取账户可达性及指定目录列表，不保存令牌，检测完成后清空输入框。先用空白测试 Vault，**不要**将真实笔记库当成测试环境。iPad 尚未通过实机验证。

## 在 Windows PowerShell 上运行

```powershell
Set-Location 'D:\AI\obsidian-vaultsail'
npm install
npm test

# 交互式读取：输入不写入 PowerShell 命令历史，但进程内仍会暂存明文 Token。
$env:VAULTSAIL_BAIDU_TOKEN = Read-Host 'Baidu access token'
$env:VAULTSAIL_BAIDU_APP_DIR = '/apps/VaultSail'
try {
    npm run probe:baidu
} finally {
    Remove-Item Env:VAULTSAIL_BAIDU_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:VAULTSAIL_BAIDU_APP_DIR -ErrorAction SilentlyContinue
}
```

请不要把 token 放进 `.env`、提交内容、截图或 Issue。机器可信、终端无屏幕录制的前提下再执行。若需要完全避免手动粘贴 token，待 OAuth 流程确认后实施正式的客户端授权模块。

## 验收结果和风险

| 项目 | 通过标准 | 当前 |
| --- | --- | --- |
| G-01 应用主体 | 可获取合法、长期可用的应用授权 | 待用户账号验证 |
| G-02 授权 | token 来源合规，支持后续安全续期 | 待验证 |
| G-03 用户信息 | 显示 `PASS`，不输出个人资料 | 未运行实网 |
| G-04 只读列目录 | 目录隔离、分页完整且响应 schema 有效 | 未运行实网 |
| G-05 上传下载权限 | 单独设计测试，先备份、检查哈希 | **未实现** |
| G-06 iPad | 实机确认授权流程与 HTTP API | 未验证 |

出现网络错误、`errno != 0`、分页不完整、目录不存在时**必须停在 D0**。不得将错误的“空列表”用于判断云端文件被删除。

## 开发状态

- `src/providers/baidu-api.ts`：只读 API 客户端，隔离网络传输、响应校验和分页；没有写入方法。
- `src/settings.ts`：跨端 Obsidian 设置页的临时令牌只读测试按钮（令牌不持久化）。
- `scripts/baidu-smoke.mjs`：开发机环境变量驱动的手工冒烟探测；不输出 token 和用户资料。
- `test/baidu-api.test.ts`：模拟 API 响应、分页失败、权限失败、路径越界、安全脱敏测试。

这一步是技术准入，不表示同步已经实现，也不表示平台权限已获批。
