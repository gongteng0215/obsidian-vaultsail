# VaultSail · 云舟

Sync Obsidian notes and attachments through your own Baidu Netdisk account, with automatic sync, version preservation, conflict resolution, and encrypted device pairing.

**English** | [简体中文](README.zh-CN.md)

[Community plugin](https://community.obsidian.md/plugins/vaultsail) · [Download 0.2.0](https://github.com/gongteng0215/obsidian-vaultsail/releases/tag/0.2.0) · [Release notes](docs/releases/0.2.0.md) · [Report an issue](https://github.com/gongteng0215/obsidian-vaultsail/issues)

**Contents:** [Install](#install-or-update) · [First connection](#connect-your-first-vault) · [Device pairing](#pair-a-computer-ipad-or-another-vault) · [Automatic sync](#automatic-sync-and-the-queue) · [Conflicts](#versions-and-conflict-resolution) · [Cloud location](#where-the-cloud-data-goes) · [Recovery](#file-scope-deletion-and-recovery) · [FAQ](#performance-and-troubleshooting) · [Privacy](#privacy-and-network-access)

## Features

- Sync Markdown, images, PDFs, and other ordinary files manually or automatically.
- Queue local changes and remote checks per vault, with configurable file concurrency.
- Use verified content hashes, a local baseline, and parent versions to identify changes, without selecting a winner by device time.
- Automatically merge compatible Markdown edits against a common ancestor. Resolve overlaps in a conflict editor, select a complete version, or keep two notes.
- Preserve competing content and recovery copies, verify transfers with SHA-256, and recover unfinished work.
- Transfer application configuration and authorization through a password-encrypted code or file, avoiding another browser login while authorization remains valid.
- View live progress, scan/transfer timings, request counts, and token refresh counts.

**0.2.0 supports Baidu Netdisk.** Requests go directly to Baidu, without a developer-operated authorization or sync server. Current settings and messages are primarily in Chinese; this guide includes their UI labels.

## Requirements and defaults

| Item | Requirement or default |
| --- | --- |
| Obsidian | **1.11.4+**, including SecretStorage |
| Baidu access | Your own account and an application approved for the required APIs |
| Configuration | Your own AppKey, SecretKey, and authorized application directory |
| Automatic sync | **Off** until enabled in each vault |
| Local change delay | About **2 seconds** of quiet; coalesced for at most **15 seconds** during continuous editing |
| Remote checks | **60 seconds** plus a small random delay; configurable **30–300 seconds** |
| Concurrent files | **8** by default; configurable **1–32**, with smaller batches for large files |
| Maximum file size | **20 MiB per file** |
| Deletion propagation | **Off**, with a separate experimental opt-in |
| Mobile background operation | Continuous background sync is **not provided** |

Intervals are scheduling targets, not delivery deadlines. Busy tasks, network errors, rate limits, background suspension, and pauses can delay execution. Automated validation passed for 0.2.0; comprehensive Windows/iPad, Baidu throughput, and long-term multi-device validation remain incomplete.

## Install or update

### Community plugins

1. Open Obsidian **Settings → Community plugins**, enabling community plugins if necessary.
2. Browse for **VaultSail**, install it, and enable it.
3. For an existing installation, click **Check for updates**, then update VaultSail.
4. Disable and re-enable the plugin, and confirm the displayed version is **0.2.0**.

Install VaultSail **in every local vault that should sync, on every participating device**. An Obsidian account login does not install it or connect Baidu automatically. Separate vaults can share one account while binding to different cloud vaults.

Update both devices to 0.2.0 before using the new merge workflow. Ordinary upgrades preserve settings and connections. Valid, unexpired pairing codes do not need re-exporting merely because the plugin was updated.

### Manual installation and BRAT

Download the ZIP or three files from the [release page](https://github.com/gongteng0215/obsidian-vaultsail/releases/tag/0.2.0). With VaultSail disabled, place them here, then enable it:

```text
<your-vault>/.obsidian/plugins/vaultsail/
├── main.js
├── manifest.json
└── styles.css
```

Use your actual configuration directory if it differs from `.obsidian`. Preserve existing `data.json` when replacing plugin files.

On iPad or desktop, another option is [BRAT](https://github.com/TfTHacker/obsidian42-brat): add `gongteng0215/obsidian-vaultsail` and select `0.2.0`.

## Connect your first vault

Settings have three tabs: **Connection & authorization** (`连接与授权`), **Cloud vault** (`云端知识库`), and **Transfer & recovery** (`传输与恢复`).

### 1. Save your application configuration

Select Baidu Netdisk. Enter AppKey and click **Save** (`保存`), then enter SecretKey and click **Save secret** (`保存密钥`). Typing alone does not save a value; check the saved-state descriptions.

Set the application directory to the path actually authorized for your application. The default `/apps/VaultSail` is a location suggestion, not proof of granted access. Use the actual approved path if different.

A Baidu login account identifies you; an approved application provides API access. Open the platform from settings to apply for your own application. Eligibility depends on Baidu's approval. Keep secrets on your devices; do not send them to the maintainer.

### 2. Authorize your account

Click **Connect Baidu Netdisk** (`连接百度网盘`). The plugin requests a device code and opens Baidu's official page. Log in there and enter the displayed code when requested. If the browser does not open, use the official link shown in settings.

Your password is entered only on Baidu's website. A browser authorization-code fallback is offered only when the application explicitly does not support device-code authorization; ordinary network errors do not switch methods automatically.

### 3. Verify file access

Use **Check read-only access** (`检查只读访问`), then **Verify file transfer** (`验证文件传输`). After confirmation, the latter uploads/downloads about 24 MiB of isolated test data: 0 B, 1 KB, 4 MiB, and 20 MiB samples, compared by content hash.

Samples remain under `vaultsail-probes/<random-id>/` inside the application directory for inspection and manual cleanup. They contain no note content. Authorization and verified file access are separate states.

### 4. Create or select a cloud vault

In Cloud vault, **create a new cloud vault** (`创建新云端库`) for a separate collection, or view existing vaults and select the intended one. Each has an independent UUID; local names can differ across devices.

An application directory is not a cloud-vault binding. An old remote ID alone does not establish a verified binding either. Changing the account, application, secret, or directory requires checking the connection and binding again.

### 5. Run the first sync

Use **Preview upload** (`预览上传`) or **Preview download** (`预览下载`) before execution, or click **Start sync** (`开始同步`) for bidirectional sync. The toolbar cloud icon also starts sync. Creating or binding a vault alone does not upload notes.

## Pair a computer, iPad, or another vault

Pairing transfers the connection, not the notes themselves. Install VaultSail on the destination first.

| Goal | Export option | Import option | Destination |
| --- | --- | --- | --- |
| Reuse the account in a different vault | Leave “Include current cloud vault” off | Leave “Bind the same cloud vault” off | Create or select this vault's own destination afterward |
| Sync the same notes on two devices | Enable “Include current cloud vault” | Enable “Bind the same cloud vault” | Both use the same verified remote UUID |

1. On the connected source, open **Export pairing configuration** (`导出配对配置`).
2. Choose whether to include the cloud vault, following the table.
3. Set and confirm a password of at least **10 characters**. Generate the code, then copy it or save a `.vaultsail` encrypted file and transfer it to your own device.
4. On the destination, open **Import pairing configuration** (`导入配对配置`), paste the code or choose the file, and enter the password.
5. Choose whether to bind the included vault. Check and confirm the import. The account, directory, and a **1 KB upload/download** are verified before replacing the connection; existing notes are retained.
6. For account-only import, create or select the local vault's destination. For same-vault pairing, verify the name and preview the first download or sync.

Account-only export/import are the defaults. Even an old code containing a cloud vault does not bind it unless you opt in. Device identity, baselines, queues, recovery data, and drafts are not migrated. Automatic sync is off after importing a connection and must be enabled locally.

Codes can be imported for **24 hours** and are not single-use. Anyone holding both code and password can reuse the authorization. Revoked access or invalid refresh tokens require a fresh export from a connected device or reauthorization. Legacy plain JSON does not contain authorization and still requires login.

Pairing uses **AES-256-GCM**, **PBKDF2-SHA-256 with 600,000 iterations**, and random salts and IVs. It protects transferred credentials, not cloud note content. See the [pairing guide](docs/PAIRING.md) for compatibility and failure handling.

## Automatic sync and the queue

After connecting, binding, and verifying file access, enable **Automatic sync** (`自动同步`) in Transfer & recovery, separately in each vault and device.

| Trigger | Behavior |
| --- | --- |
| Local create, edit, delete, or rename | Queue affected paths; wait for 2 seconds of quiet, coalescing at most 15 seconds of continuous editing |
| Another device publishes a change | Discover it on the next foreground remote check, default 60 seconds plus jitter |
| Startup or return to foreground | Verify pending work and schedule a full check when automatic sync is enabled |
| Periodic verification | Schedule a full check every 10 minutes while automatic sync is active |
| Click Start sync during a task | Queue a follow-up pass; repeated clicks are coalesced |
| App enters background | Stop dispatching and request a pause; an in-flight request may still finish |

One vault executes one task at a time, with concurrent files inside it. New edits remain queued. Download-generated events are compared with the verified baseline to avoid re-upload loops.

Routine work re-reads changed files and files affected by remote updates. An unchanged remote-only check does not read every local note body. Cloud history still needs enumeration; first scans and missing cache fingerprints can require more requests.

Network errors and rate limits back off and honor server wait instructions. Authentication, integrity, and unresolved recovery failures stop automatic retries for intervention. **Pause current task** (`暂停当前任务`) takes effect after active requests finish. A user pause persists until you explicitly start again; returning to foreground does not clear it.

## Versions and conflict resolution

VaultSail uses a verified baseline, content hashes, and a parent-version graph. It follows the common-ancestor principle used in version control; it does not run Git or store notes on GitHub.

| Situation | Result |
| --- | --- |
| Only one side changed from baseline | Transfer the change after revalidation |
| Both sides have identical content | Skip redundant content; identical-content branches can converge |
| B receives A's edit, then edits that version | B publishes a descendant that A can receive as a subsequent change |
| A and B edit independently from an older version | Preserve both branches and try a bounded three-way Markdown merge |
| Overlapping changes or ambiguous ancestry | Preserve competing content and list a conflict |
| Deletion versus modification | Retain competing content; deletion also needs the separate deletion setting and explicit conflict choice |

**Modification time does not select a winner.** Sequential edits in wall-clock time can still conflict if the second device never received the first edit.

Automatic merging applies to eligible UTF-8 Markdown. Each input/output is at most **256 KiB**; line comparisons are limited to **3,000 lines** and **2 million difference-table cells**. Compatible edits with a unique common ancestor may merge automatically. Overlaps, concurrently changed YAML frontmatter, ambiguous ancestors, and multiple differing branches need review. Images, PDFs, and files outside the budget use complete-version choices.

Open **View pending conflicts** (`查看待解决冲突`) to compare local content, the common ancestor when available, and cloud branches. Choose either side or both per block, edit the full result and confirm manual completion, select a whole version, or keep two synced notes with distinct names. Concurrent renames require choosing a final path.

Closing the editor saves a local draft. If versions change before confirmation, submission stops and the draft is preserved. Confirmed resolutions reference the competing branches for other devices to receive. Independent files can continue syncing while an ordinary content conflict remains unresolved.

Copies in `VaultSail-conflicts/` are excluded from sync. A second note created using **Keep both** is a regular synced file; these serve different purposes.

## Where the cloud data goes

```text
<authorized-application-directory>/vaultsail/vaults/<remote-vault-uuid>/
├── vault.json           # Vault identity and format
├── blobs/<sha256>       # Immutable content objects
└── ops/<device-id>/     # Immutable version/operation records
```

The default prefix is `/apps/VaultSail/vaultsail/vaults/`. Check the plugin's cloud location and version listing for the actual path and ID.

This is version storage. Downloads reconstruct normal note paths; `blobs` is not a filename mirror. VaultSail does not import arbitrary files elsewhere in the drive. Old cloud objects are not permanently garbage-collected in this release, so usage can exceed your current local note size.

## File scope, deletion, and recovery

Eligible ordinary files include Markdown, images, PDFs, Chinese paths, and zero-byte files, up to 20 MiB each. Exclusions include dot-prefixed path components, the current Obsidian configuration directory, `node_modules`, `Thumbs.db`, `VaultSail-conflicts/`, and `VaultSail-配置/`. Internal `.vaultsail-state/` data is excluded too. Themes, plugins, settings, and credentials are not copied as notes.

Deletion propagation is off. Missing a file alone does not authorize deleting the other side. The experimental option uses versioned deletion records and local recovery data; it does not permanently remove cloud content objects.

Downloads are staged and hash-checked before application; replacements retain recovery copies. Journals record upload, publication, local application, and baseline progress so recovery can verify actual outcomes.

After interruption, use **Resume unfinished tasks** (`恢复未完成任务`). If newer edits prevent safe recovery, use **End old task and preview again** (`结束旧任务并重新预览`) and inspect the new plan. **View recovery points** (`查看恢复点`) restores prior content, preserving current content first. Recovery data and drafts remain in `.vaultsail-state/<device-id>/` without automatic cleanup. Do not delete internal state to bypass errors.

## Performance and troubleshooting

| Symptom or question | What to check |
| --- | --- |
| “Application not configured” after typing | Click Save for AppKey and Save secret for SecretKey; check saved-state descriptions |
| “Account or directory is not bound” | Select a verified cloud vault; authorization and a directory alone are insufficient |
| No automatic sync | Confirm 0.2.0 is loaded, automatic sync enabled, file checks passed, app foregrounded, and queue not paused or blocked |
| Remote edits are not immediately visible | The other device must publish first; this device discovers them through remote checks or manual sync |
| Long scan without uploads | Check scan time, request counts, and cache statistics; initial history loading or missing fingerprints can add requests |
| Slow transfers | Compare scan and transfer time; adjust concurrency from 1–32, default 8. Large files reduce batch concurrency; network/Baidu limits still apply |
| Does every sync log in again? | No. Stored authorization is reused; tokens refresh near expiry or after an explicit invalid-token response |
| Pairing import fails | Check version, 24-hour window, password, and failure step; share only the redacted report |
| iPad stops in the background | Keep Obsidian foregrounded; unfinished work is checked on return |

Higher concurrency does not eliminate enumeration or verification. Elapsed time updates during pending requests; verified bytes increase only after verification. [Performance measurements](docs/PERFORMANCE.md) are historical simulated comparisons, not guaranteed Baidu throughput.

## Privacy and network access

Secrets and tokens use **Obsidian SecretStorage**; settings store references. Requests go directly to Baidu OAuth (`openapi.baidu.com`), file APIs (`pan.baidu.com`, `d.pcs.baidu.com`), and allowed HTTPS download hosts under `baidu.com` / `baidupcs.com`.

There is no project-operated authorization server, telemetry, advertising, or plugin self-updater. The plugin enumerates vault paths, reads eligible content, and writes transfers, state, and recovery copies within the vault. Clipboard actions write a code or path only when requested; the plugin does not read the clipboard.

Diagnostics exclude credentials, account identity, filenames, note bodies, and drafts. Do not attach `data.json`, pairing codes, passwords, SecretKey, or raw authorization responses to issues. **Cloud notes are not end-to-end encrypted**; pairing encryption protects connection transfer only.

Local disconnect removes local authorization; it does not claim to revoke Baidu access. Use the official authorization-management link for remote revocation.

## Development and verification

Use Node.js **22+** and PowerShell 7 for packaging:

```sh
npm ci
npm test
npm run build
pwsh ./scripts/package-release.ps1
```

0.2.0 passed **158 automated tests**, type checking, build, ZIP validation, and public-download hash checks. Coverage includes authorization, pairing, pagination, concurrency, paths, queues, incremental scans, reload serialization, merging, drafts, concurrent renames, and recovery. Tests use simulated providers and a DOM fixture; they do not certify real iPad storage/background execution, Baidu permissions, or long-term shared-token behavior.

The ZIP contains only `main.js`, `manifest.json`, and `styles.css`, without tests, user configuration, credentials, or notes. See [release notes](docs/releases/0.2.0.md) for validation limits and [sync design](docs/AUTO_SYNC_PLAN.md) for implementation context.

## License and support

Maintained by [gongteng0215](https://github.com/gongteng0215). Licensed under [MIT](LICENSE). Runtime dependency `@noble/hashes` is also MIT-licensed; see [third-party notices](THIRD_PARTY_NOTICES.md).

For [issue reports](https://github.com/gongteng0215/obsidian-vaultsail/issues), include plugin/Obsidian versions, platform, reproduction steps, the safe error message, and a redacted report when relevant. Hide private note and account information in screenshots.
