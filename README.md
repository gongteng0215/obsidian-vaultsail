# VaultSail (云舟)

> Your vault, every cloud. 让知识自由穿行于每一朵云。

**Status: D0 feasibility prototype — NOT a working cloud-sync plugin.**

VaultSail is an open-source Obsidian plugin project focused on safe cross-device and eventual multi-cloud synchronization. Windows and iPadOS are primary targets. Baidu Netdisk is the intended first storage backend. Future backends may include OneDrive, WebDAV, S3 and Google Drive.

## Current features (v0.1.1 D0 prototype)

- Loads as an Obsidian community plugin on desktop/mobile (mobile still needs real-device verification).
- Local file inventory preview; **read-only**.
- Baidu D0 API probe within plugin settings on desktop/mobile (requires your own temporary authorized token; real-device testing pending). The probe clears the token after running and makes no write requests.
- Setting for intended provider and per-Vault remote ID; **does not access cloud APIs**.
- Provider abstraction ready for separate backends.
- Pure three-way file reconciliation planner with unit tests; **not connected to live files**.

**Not available yet:** Baidu authorization, remote listings, uploads, downloads, encryption, actual sync, conflict backup, delete propagation, or reliable iPad sync. This build makes NO remote changes and NO file changes.

## D0 Baidu API read-only checks

The development-machine-only probe and mobile-friendly in-plugin D0 test are described in [D0_BAIDU_PROBE.md](docs/D0_BAIDU_PROBE.md). It validates limited OAuth token access and safe listing with mocks first. **No real Baidu account access has been validated.**

## Development

Requires Node.js 22+ and npm:

```bash
npm install
npm test
npm run build
```

The build produces `main.js`. Copy `main.js`, `manifest.json`, and `styles.css` to `<Your Vault>/.obsidian/plugins/vaultsail/`, then enable the plugin from Obsidian's Community plugins screen. For iterative development, use `npm run dev` and copy/update `main.js` as needed.

## Windows project directory

Recommended repo clone path: `D:\AI\obsidian-vaultsail`.
To create and publish the new repository see [SETUP_WINDOWS.md](docs/SETUP_WINDOWS.md).

## Architecture & roadmap

- [Multi-cloud design](docs/MULTI_CLOUD_ARCHITECTURE.md)
- [PRD and phased plan](docs/PRD.md)
- [Feasibility checklist](docs/FEASIBILITY.md)
- [D0 Baidu read-only probe instructions](docs/D0_BAIDU_PROBE.md)

Safety rules: remote errors must not become empty inventories; first sync must not infer deletions; never silently overwrite conflicts; delete operations require explicit opt-in after baseline and backup design are implemented.

## License

MIT. Contributions are welcome once API viability and test coverage are established.
