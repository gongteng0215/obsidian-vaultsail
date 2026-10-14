# VaultSail (云舟)

> Your vault, every cloud. 让知识自由穿行于每一朵云。

**Status: 0.1.10 local test candidate. OAuth and manual transfer code implemented; real Baidu account and iPad validation pending.**

VaultSail is an open-source Obsidian plugin project focused on safe cross-device and eventual multi-cloud synchronization. Windows and iPadOS are primary targets. Baidu Netdisk is the intended first storage backend. Future backends may include OneDrive, WebDAV, S3 and Google Drive.

## Current features (v0.1.10 test candidate)

- Chinese setup wizard for the user's own Baidu application and account; no hosted server or shared private app credentials.
- Distinctive VaultSail workspace with connection, remote vault and transfer tabs; explicit local AppKey/SecretKey save state.
- Device-code OAuth, restricted authorization-code fallback, local SecretStorage and coordinated token refresh.
- Isolated file roundtrip checks and account-scoped remote vault creation/binding.
- Manual upload/download preview, SHA-256 verification, immutable blobs and operation records.
- Live scan/transfer/verification progress, verified-content sizes, elapsed time and per-device last-success status.
- Read-only remote file/version inventory and human-readable Baidu storage paths.
- Portable JSON pairing export/import for another device; credentials, device identity and queues stay local.
- Conflict preservation, interrupted-task recovery and local history restoration.
- One-click baseline-based bidirectional sync in preview; single-sided changes transfer automatically, simultaneous edits keep visible conflict copies and immutable branches.
- Explicit tombstones remain behind the deletion experiment; deletion propagation is disabled by default.
- Cross-platform Obsidian file/network APIs; desktop/mobile runtime verification remains pending.

This candidate can write local and remote files after explicit user actions. It does not provide end-to-end encryption, automatic content merging, continuous mobile background sync or stable cross-device guarantees. Single-file limit: 20 MiB; concurrency: 1. Configuration and internal state directories are excluded.

## Configure your application

See [用户配置与测试](docs/USER_SETUP.md): configure your own AppKey, save your own SecretKey through SecretStorage, enter the actually authorized app directory, connect through Baidu's official page, run isolated roundtrip validation, then bind a remote vault. Each device authorizes independently. See [设备配对配置](docs/PAIRING.md) to move application and vault pairing information to iPad. Never send credentials to the developer.

## Install the local test candidate

1. Build and package the project to obtain `dist/vaultsail-0.1.10.zip`, or obtain the candidate from [CI artifacts](https://github.com/gongteng0215/obsidian-vaultsail/actions). The published [0.1.1 D0 release](https://github.com/gongteng0215/obsidian-vaultsail/releases/tag/0.1.1) remains unchanged and does not support OAuth.
2. Extract the ZIP into an empty test Vault's `.obsidian/plugins/` directory. The resulting files must be `.obsidian/plugins/vaultsail/main.js`, `manifest.json`, and `styles.css`.
3. Restart Obsidian, open **Settings → Community plugins**, enable community plugins if needed, then enable **VaultSail**. Requires Obsidian **1.11.4 or newer**. A custom Obsidian configuration directory replaces `.obsidian` in these paths.
4. Open **Settings → VaultSail** and follow the Chinese setup guide. First test with an empty or disposable Vault.

The candidate requires native installation and real-account checks before its GitHub Release is published. Implementation and actual verification are tracked separately in [实施状态](docs/IMPLEMENTATION_STATUS.md).

## Development

Requires Node.js 22+ and npm:

```bash
npm ci
npm test
npm run build
pwsh ./scripts/package-release.ps1
```

The build produces `main.js`. Copy `main.js`, `manifest.json`, and `styles.css` to `<Your Vault>/.obsidian/plugins/vaultsail/`, then enable the plugin from Obsidian's Community plugins screen. For iterative development, use `npm run dev` and copy/update `main.js` as needed.

## Windows project directory

Recommended repo clone path: `D:\AI\obsidian-vaultsail`.
To create and publish the new repository see [SETUP_WINDOWS.md](docs/SETUP_WINDOWS.md).

## Architecture & roadmap

- [Multi-cloud design](docs/MULTI_CLOUD_ARCHITECTURE.md)
- [PRD and phased plan](docs/PRD.md)
- [Feasibility checklist](docs/FEASIBILITY.md)
- [User setup and verification](docs/USER_SETUP.md)
- [Implementation and acceptance status](docs/IMPLEMENTATION_STATUS.md)
- [Legacy D0 development-only probe](docs/D0_BAIDU_PROBE.md)

Safety rules: remote errors must not become empty inventories; first sync must not infer deletions; never silently overwrite conflicts; delete operations require explicit opt-in after baseline and backup design are implemented.

## License

MIT. Contributions are welcome once API viability and test coverage are established.
