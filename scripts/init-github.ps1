# VaultSail: run only on your own Windows PC in D:\AI\obsidian-vaultsail.
# Requires Git, GitHub CLI (`gh`) and a logged-in account with repo creation rights.
$ErrorActionPreference = 'Stop'
$project = 'D:\AI\obsidian-vaultsail'
$repository = 'gongteng0215/obsidian-vaultsail'
if (-not (Test-Path (Join-Path $project 'package.json'))) { throw "Cannot find VaultSail project at $project" }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Install Git first.' }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'Install GitHub CLI first.' }
Set-Location $project
gh auth status
if ($LASTEXITCODE -ne 0) { throw 'Run gh auth login first.' }
if (-not (Test-Path '.git')) { git init -b main }
git add .
$changes = git status --porcelain
if ($changes) { git commit -m 'chore: initialize VaultSail D0 project' }
gh repo view $repository *> $null
if ($LASTEXITCODE -ne 0) {
  gh repo create $repository --public --source . --remote origin --push
  if ($LASTEXITCODE -ne 0) { throw 'GitHub repository creation failed; verify permissions.' }
} else {
  if (-not (git remote get-url origin 2>$null)) { git remote add origin "https://github.com/$repository.git" }
  git branch -M main
  git push -u origin main
  if ($LASTEXITCODE -ne 0) { throw 'Git push failed; review remote history before retrying.' }
}
Write-Host "Repository: https://github.com/$repository"
