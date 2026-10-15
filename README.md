# VaultSail

Sync notes and attachments through Baidu Netdisk with version preservation and password-encrypted device pairing.

[中文使用说明](docs/USER_SETUP.md) · [电脑与 iPad 配对](docs/PAIRING.md)

## Features

- Start bidirectional sync with one click, or preview upload, download and sync changes first.
- Compare files against a verified baseline. Concurrent edits preserve every valid version and create visible conflict copies.
- Verify transferred content with SHA-256. Recover unfinished operations and restore local recovery copies.
- Export a password-encrypted pairing code or file containing your application credentials and authorization. Import it on another device to verify the account, remote vault and a small file roundtrip automatically, without repeating browser login.
- See scan, transfer and verification progress, elapsed time, last completion and remote version locations.
- Keep deletion propagation off by default. Exclude Obsidian configuration, credentials, internal state and recovery folders from note sync.

Baidu Netdisk is the current provider. Transfers are manual, with a 20 MiB per-file limit and concurrency of one. Pairing configuration is encrypted; note contents stored in the cloud are **not** end-to-end encrypted. Automatic text merging and continuous mobile background sync are not provided.

## Install

Requires **Obsidian 1.11.4 or newer**. The [community listing](https://community.obsidian.md/plugins/vaultsail) has been submitted; installation through the directory depends on completing its review.

For manual installation, download the latest ZIP or the three individual files from [GitHub Releases](https://github.com/gongteng0215/obsidian-vaultsail/releases/latest). Place `main.js`, `manifest.json` and `styles.css` in `plugins/vaultsail/` under the current vault's configuration directory, then enable VaultSail. The default directory is `.obsidian`; custom configuration directories are supported.

## Connect your first device

1. Obtain your own AppKey and SecretKey from an approved Baidu application. A Baidu login account alone does not grant file API access.
2. Save the credentials in the connection tab and set the application's actually authorized `/apps/application-name` directory. The default `/apps/VaultSail` does not imply that access is already approved.
3. Connect through Baidu's official authorization page.
4. Create or bind a remote vault and verify file transfer permissions.
5. Start sync, or preview the changes first.

The remote vault stores `vault.json`, immutable content under `blobs`, and version operations under `ops`. Downloads reconstruct normal note paths. VaultSail does not mirror arbitrary existing files from elsewhere in your drive.

## Pair another device

Export a pairing code on the connected computer using a password of at least ten characters. Install the same version on the target device, import the code or encrypted file, and enter that password. After automatic account, vault and local transfer validation, the device can sync without another browser login. Codes can be imported for 24 hours. Device identity, baselines and task queues remain independent.

Revoked authorization or an invalid refresh token cannot be restored by encryption. Re-export from a connected device or authorize again when required. Legacy non-secret JSON configuration still requires a separate login. See the [pairing guide](docs/PAIRING.md).

## Accounts, network and privacy

**A Baidu account, an approved application and network access are required.** VaultSail connects directly to Baidu OAuth (`openapi.baidu.com`), file APIs (`pan.baidu.com`, `d.pcs.baidu.com`) and official HTTPS download hosts under `baidu.com`/`baidupcs.com` to authorize, list, upload and download files. Application and authorization management pages open after a user action.

There is no developer-hosted authorization or sync server. Credentials are stored through Obsidian SecretStorage; plugin settings contain references. The plugin has no ads, telemetry, self-updater or file access outside the vault. It enumerates vault file paths to plan sync and writes only the requested note transfers, recovery copies and internal state. Its clipboard use writes a pairing code or storage path only after you choose to copy; it does not read clipboard contents. Diagnostics exclude credentials, filenames and note contents.

Anyone holding both a pairing code and its password can reuse its authorization. Share them only with your own devices, never in issue reports.

## Verification and development

86 automated tests cover authorization, encrypted pairing, file APIs, pagination, concurrent changes, recovery, path safety and configuration privacy. Real iPad import, device storage/Web Crypto, large real-world transfers and long-term shared-token refresh remain unverified by the developer. Simulated checks are not real-device certification. See [implementation status](docs/IMPLEMENTATION_STATUS.md) and [performance measurements](docs/PERFORMANCE.md).

Use Node.js 22+, then run `npm ci`, `npm test`, `npm run build` and `pwsh ./scripts/package-release.ps1`. The installation ZIP contains only the three plugin files, never tests, user settings, credentials or notes.

## License and support

[MIT](LICENSE). The runtime dependency `@noble/hashes` uses MIT; its license is included in the build and [third-party notices](THIRD_PARTY_NOTICES.md). Report problems through [GitHub Issues](https://github.com/gongteng0215/obsidian-vaultsail/issues).
