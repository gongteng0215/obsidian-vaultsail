# VaultSail

Sync notes and attachments through Baidu Netdisk with version preservation and password-encrypted device pairing.

[中文使用说明](docs/USER_SETUP.md) · [电脑与 iPad 配对](docs/PAIRING.md)

## Features

- Sync manually or opt into automatic sync with coalesced file events, remote checks and persistent queued work.
- Merge bounded Markdown edits against a common ancestor. Resolve overlaps in a conflict inbox, edit a persistent draft, select a complete version, or keep both as normally synced files.
- Verify transferred content with SHA-256. Recover unfinished operations and restore local recovery copies.
- Export a password-encrypted code or file containing your application credentials and authorization. Account-only export and import are the default: each vault chooses its own cloud destination. Sharing an existing remote vault requires an explicit choice at both ends.
- See scan, transfer and verification progress, elapsed time, last completion and remote version locations.
- Keep deletion propagation off by default. Exclude Obsidian configuration, credentials, internal state and recovery folders from note sync.

Baidu Netdisk is the current provider. Automatic sync requires opt-in after upgrade: local changes wait for 2 seconds of quiet (up to 15 seconds while editing); foreground remote checks default to 60 seconds plus jitter, configurable from 30 to 300. Transfers retain the 20 MiB limit and default eight concurrent files (configurable 1–32), with smaller batches for large attachments. Markdown merging is bounded to 256 KiB and a limited line-diff budget; overlapping edits and ambiguous ancestry require review. Pairing is encrypted; cloud notes are **not** end-to-end encrypted. Continuous mobile background sync is not provided.

## Install

Requires **Obsidian 1.11.4 or newer**. The [community listing](https://community.obsidian.md/plugins/vaultsail) is restored, and **0.1.17** completed the automated review with no blocking errors on October 15, 2026. The in-app search catalog updates separately from the listing. Automated review does not replace real-device validation.

**[0.2.0 is an automatic-sync and merge test release](https://github.com/gongteng0215/obsidian-vaultsail/releases/tag/0.2.0) awaiting real Windows/iPad validation.** It is developed on a separate branch; the default branch's community manifest remains at 0.1.23. Pin 0.2.0 in BRAT or install its files manually. See the [test-build notes](docs/releases/0.2.0.md). Community installation follows the default-branch manifest; a prerelease flag alone does not isolate updates.

For direct GitHub installation on iPad, install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat) through Obsidian's community plugins, then add `gongteng0215/obsidian-vaultsail` and select version `0.2.0`. Enable VaultSail in an empty test vault before importing an encrypted pairing code.

For manual installation, download the ZIP or the three individual files from the [0.2.0 test release](https://github.com/gongteng0215/obsidian-vaultsail/releases/tag/0.2.0). Place `main.js`, `manifest.json` and `styles.css` in `plugins/vaultsail/` under the current vault's configuration directory, then enable VaultSail. The default directory is `.obsidian`; custom configuration directories are supported.

## Connect your first device

1. Obtain your own AppKey and SecretKey from an approved Baidu application. A Baidu login account alone does not grant file API access.
2. Save the credentials in the connection tab and set the application's actually authorized `/apps/application-name` directory. The default `/apps/VaultSail` does not imply that access is already approved.
3. Connect through Baidu's official authorization page.
4. Create or bind a remote vault and verify file transfer permissions.
5. Start sync, or preview the changes first.

The remote vault stores `vault.json`, immutable content under `blobs`, and version operations under `ops`. Downloads reconstruct normal note paths. VaultSail does not mirror arbitrary existing files from elsewhere in your drive.

## Pair another device

Export an account connection on the connected computer using a password of at least ten characters. Install version 0.1.17 or newer on the target device, import the code or encrypted file, and enter that password. Account and small file transfer checks run automatically, without repeating browser login. The current vault then creates or selects its own remote vault. To sync the same vault across devices, explicitly include its destination when exporting and explicitly bind it when importing. Old codes may still contain a destination; 0.1.17 ignores it unless you opt in. Codes can be imported for 24 hours. Device identity, baselines and task queues remain independent.

Revoked authorization or an invalid refresh token cannot be restored by encryption. Re-export from a connected device or authorize again when required. Legacy non-secret JSON configuration still requires a separate login. See the [pairing guide](docs/PAIRING.md).

## Accounts, network and privacy

**A Baidu account, an approved application and network access are required.** VaultSail connects directly to Baidu OAuth (`openapi.baidu.com`), file APIs (`pan.baidu.com`, `d.pcs.baidu.com`) and official HTTPS download hosts under `baidu.com`/`baidupcs.com` to authorize, list, upload and download files. Application and authorization management pages open after a user action.

There is no developer-hosted authorization or sync server. Credentials are stored through Obsidian SecretStorage; plugin settings contain references. The plugin has no ads, telemetry, self-updater or file access outside the vault. It enumerates vault file paths to plan sync and writes only the requested note transfers, recovery copies and internal state. Its clipboard use writes a pairing code or storage path only after you choose to copy; it does not read clipboard contents. Diagnostics exclude credentials, filenames and note contents.

Anyone holding both a pairing code and its password can reuse its authorization. Share them only with your own devices, never in issue reports.

## Verification and development

127 automated tests cover authorization, encrypted pairing, custom/default concurrency, bounded parallel transfers, serialized recovery commits, pagination, concurrent changes, path safety and configuration privacy. Real iPad import, device storage/Web Crypto, large real-world transfers and long-term shared-token refresh remain unverified by the developer. Simulated checks are not real-device certification. See [implementation status](docs/IMPLEMENTATION_STATUS.md) and [performance measurements](docs/PERFORMANCE.md).

Use Node.js 22+, then run `npm ci`, `npm test`, `npm run build` and `pwsh ./scripts/package-release.ps1`. The installation ZIP contains only the three plugin files, never tests, user settings, credentials or notes.

## License and support

[MIT](LICENSE). The runtime dependency `@noble/hashes` uses MIT; its license is included in the build and [third-party notices](THIRD_PARTY_NOTICES.md). Report problems through [GitHub Issues](https://github.com/gongteng0215/obsidian-vaultsail/issues).
