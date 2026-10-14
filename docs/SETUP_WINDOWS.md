# Windows 安装与 GitHub 首次建仓

> 当前 0.1.2 安装和授权步骤请以 [USER_SETUP.md](USER_SETUP.md) 为准，需要 Obsidian 1.11.4+。下面的建仓和 D0 段落保留为历史记录。

## 推荐目录

`D:\AI\obsidian-vaultsail`

把 `obsidian-vaultsail-starter.zip` 解压到 `D:\AI`，确保 `D:\AI\obsidian-vaultsail\package.json` 存在。

## 本地构建

打开 PowerShell：

```powershell
Set-Location 'D:\AI\obsidian-vaultsail'
npm install
npm test
npm run build
```

## GitHub 发布

当前 Github 连接器没有创建仓库权限。你可以安装 GitHub CLI (`winget install GitHub.cli`)，然后：

```powershell
Set-Location 'D:\AI\obsidian-vaultsail'
gh auth login
git init -b main
git add .
git commit -m 'chore: initialize VaultSail Obsidian plugin scaffold'
gh repo create gongteng0215/obsidian-vaultsail --public --source . --remote origin --push
```

如果仓库已由你在网页手动创建，改用 `git remote add origin https://github.com/gongteng0215/obsidian-vaultsail.git` 与 `git push -u origin main`。

## 安装开发插件到某个 Vault

```powershell
$pluginPath = 'D:\PATH\TO\YOUR\VAULT\.obsidian\plugins\vaultsail'
New-Item -ItemType Directory -Force -Path $pluginPath | Out-Null
Copy-Item 'main.js','manifest.json','styles.css' -Destination $pluginPath
```

打开 Obsidian → 设置 → 第三方插件 → 启用 VaultSail。运行命令 `Preview local vault file inventory (read-only)`。

**注意：本构建并不支持真实云同步，测试请用空白 Vault，勿把未完成的程序当成备份。**

## D0 版本一键初始化 GitHub

在项目目录执行 `powershell -ExecutionPolicy Bypass -File .\scripts\init-github.ps1`，命令会检查 gh 登录、初始化本地 git 并尝试创建或推送仓库。只可在你自己的 Windows 机器运行。
