# VaultSail version roadmap

Current local preview **0.2.22** implements categorized performance evidence, truthful parallel-check states, queue/pause regressions and native acceptance tools. [Evidence](releases/0.2.22.md) · [Native checklist](acceptance/0.2.22.md). Simulation and native validation remain separate. Move to the 0.3.0 candidate after native dual-device acceptance, then observe at least seven days. Keep natural renewal pending if it has not actually occurred.

Local preview **0.2.19** overlaps read-only preflight checks, coalesces in-flight listing pages, and adds numeric local performance reporting. [Validation and remaining native acceptance](releases/0.2.19.md).

Release **0.2.18** adds remote history cache fixes, persistent directory caches and parallel inventories, including empty-folder sync, diagnostics and application setup guidance from 0.2.15–0.2.17. [Evidence and validation](releases/0.2.18.md). Native dual-device and live Baidu performance acceptance remain pending.

**English** | [简体中文](ROADMAP.zh-CN.md) · [Feature inventory](../README.md#feature-inventory)

Baseline: **0.2.22 local preview / last recorded public release 0.2.18**, updated **2026-10-20**. Version 0.2.14 adds [stable background UI updates](releases/0.2.14.md). Version 0.2.13 makes [deletion sync a standard opt-in setting](releases/0.2.13.md). Version 0.2.12 adds the [cloud file tree](releases/0.2.12.md). Versions 0.2.6–0.2.8 add the transfer center, parallel slices and compact layouts; 0.2.9 adds scan improvements and local performance summaries. Versions 0.2.10–0.2.11 add immediate click feedback, automatic task notifications and ribbon activity/warning states. See [automatic notifications](releases/0.2.11.md), [click feedback](releases/0.2.10.md) and [scan validation](releases/0.2.9.md). Native dual-device acceptance remains separate; later milestones advance on evidence, not promised dates.

## Direction and lasting boundaries

Make notes sync reliably between computers and iPad using the user's own cloud account. Ordinary edits should flow automatically, genuine conflicts should be understandable, and failures should leave recoverable content.

- User-owned applications and accounts, direct provider access, no shared project secrets or developer sync server.
- One primary destination per local vault; independent device identity, baseline, queue, and recovery state.
- Decide by content and ancestry, never device time. Unknown writes, damaged objects, and incomplete listings cannot mean success or an empty vault.
- Deletion off by default, preserve conflicting content, exclude credentials/configuration, and retain verification during optimization.
- Preserve existing pairing, configuration, notes, and manual entry points. Format migration needs preflight, backup, and recovery.
- Keep both READMEs, capability status, and release notes aligned. Record automated and real-device results separately.

## Milestones

| Version | Status | Focus | Completion evidence |
| --- | --- | --- | --- |
| 0.2.22 | Local preview | Dual-device reliability, categorized metrics and acceptance tooling | Automated/synthetic checks; real Baidu and native acceptance pending |
| 0.2.6–0.2.9 | Local previews implemented | Transfer center, parallel slices, compact UI, scan performance and local summaries | 207 automated tests in 0.2.9; native dual-device/Baidu performance acceptance pending |
| 0.2.0 | Released | Automatic sync and merge foundation | README inventory; 158 automated tests, comprehensive native acceptance pending |
| 0.2.4 | Released | Local sync history, oversized-file isolation, desktop 512 MiB attachments, live upload progress | 186 automated checks; 339/512 MiB simulated integrity checks; native acceptance pending |
| 0.2.x follow-ups | Ongoing | Stabilize current behavior | Explainable repeat sync, queue, and recovery; no known blocking loss or cross-vault failures |
| 0.3.0 | Planned | iPad and multi-vault reliability | Native records for two devices/two destinations, lifecycle and credentials |
| 0.4.x | Planned | Large-attachment memory measurement, chunked I/O and recoverable transfers | Platform/integrity gates before deciding supported scope, no GB promises |
| 0.5.0 | Planned | History and recovery workspace | Search, preview, and restore cloud history; clearer local recovery |
| 0.6.0 | Planned | Scope, languages, accessibility | Previewable rules, complete English/Chinese UI, usable small screens |
| 0.9.0 RC | Planned | Freeze features, rehearse upgrades | Complete acceptance/migration records and at least 7 days of observation |
| 1.0.0 | Conditional | Stable maintenance release | RC gates passed; platform support, limits, and recovery documented |

Version gaps leave room for fixes. Additional providers, large files, and encryption will not all start before the foundation is reliable.

The [large-file plan](LARGE_FILES.md) adds a conditional track: 0.2.x isolates oversized files and removes chunk copies; 0.3.x proves platform capabilities and compatible readers; 0.4.x evaluates higher limits/chunk I/O only after gates pass; 0.5.x or later improves recovery. Current desktop whole-buffer transfers default to 512 MiB; mobile stays at 20 MiB. Desktop results do not qualify iPad or promise GB support.

Implementation: [separate 0.2.1 preview](releases/0.2.1.md) now includes local oversized-file skips, related-path protection, partial-result lists, and on-demand upload chunks. 168 automated checks pass; native acceptance is pending and these features are included in community release 0.2.4. Other milestones remain open.

[Local preview 0.2.2](releases/0.2.2.md) adds persistent local sync-task/file records, live status, and filters, with 178 automated checks. This is an activity log, not the planned cloud-content timeline or old-version restore; the 0.5.0 recovery milestone remains open.

## 0.2.1 / 0.2.x: stabilize the current release

### Deliverables

1. Track actual findings with version, platform, trigger steps, safe errors, and reproducible evidence; make focused fixes after establishing causes.
2. Keep settings messages aligned with actual queue and merge behavior; deletion controls were simplified in 0.2.13.
3. Distinguish debounce, waiting for remote checks, scanning, transfer, rate-limit retry, user pause, and intervention states, so no changes and no running task are not confused.
4. Verify clicks while busy, continued editing, reload, reconnect, and foreground return after pause.
5. Verify repeated sync does not add versions/copies; recovery checks unknown writes before resubmission.
6. Add safe diagnostic fields only where needed to reproduce failures; show data locally without telemetry.

### Acceptance

- Keep the automated baseline passing and add regression coverage for actual failure chains.
- A burst of 100 edits, editing during transfer, and repeated clicks neither lose pending work nor start overlapping tasks.
- Ten consecutive manual syncs of unchanged content create no additional versions; the UI distinguishes scanning, skipping, and failure.
- Interrupt before/after publication and local application; recovery yields matching hashes or explicitly retained conflicts.
- Ordinary conflicts do not block independent files; integrity/format failures continue to block unsafe operations.
- Record real outcomes where devices are available. Otherwise leave native acceptance pending instead of closing it with a simulation.

## 0.3.0: iPad and multi-vault reliability

### Deliverables

- Validate native iPad SecretStorage, Web Crypto, file selection/paste, and restart behavior on top of existing pairing.
- Clarify account-only versus same-vault results and improve import progress/retry guidance while preserving rollback.
- Verify foreground recovery when old background requests arrive late, and explain OS suspension in the UI.
- Verify two local vaults, two destinations, account/application switching, copied configuration, and old-queue isolation.
- Test long-running shared authorization/refresh-token behavior. If provider restrictions exist, document them and design compatibility rather than treating them as random network errors.

### Acceptance

- Windows and iPad each use two local vaults bound to two cloud vaults without cross-vault writes.
- Transfer 100 mixed files across devices and compare every hash, including Chinese paths, Markdown, images, PDFs, empty files, and near-limit attachments.
- Twenty background/foreground transitions leave explainable queue/journal states; user pauses remain paused.
- Cover refusal, cancellation, wrong passwords, expired codes, secret-save failures, rollback, account changes, and real refresh scenarios.
- Release notes list tested Obsidian/iPadOS/Windows versions and remaining gaps. No continuous iPad background promise.

## 0.4.x: large-attachment memory, chunked I/O and recovery

First measure peak memory on desktop and iPad, then prove bounded read/write slices and recoverable transfers before deciding scope. Current scan comparisons remain regression evidence. Discovery indexes below are conditional research only; 0.2.22 does not add an index or change remote formats.

### Deliverables

- Separately measure first scan, unchanged repeat, plugin restart, single-file edits, and batches; separate local scan, cloud scan, and transfers.
- Evaluate per-device discovery indexes/checkpoints on top of existing caches and incremental reads to reduce history enumeration and repeated fetches.
- Treat an index only as a verified discovery hint. A single mutable manifest must not overwrite concurrent history; missing, stale, damaged, or incomplete data falls back to full validation.
- Evaluate adaptive scheduling against attachment memory, rate limits, and failure rates, retaining the user's concurrency ceiling and default 8.
- Show understandable request/cache statistics. Any format change first specifies migration and old-client behavior.
- Large attachments follow separate platform, compatibility, and memory gates in the [detailed plan](LARGE_FILES.md); a performance release does not automatically unlock higher limits.

### Acceptance

- Fixed 7-, 100-, and 1,000-file datasets; record cold, warm, restarted, and single-edit scans. Ten or more samples permit P95; smaller native groups use median/range. Keep platform, task type, network and initialization state separate.
- Record datasets, network conditions, and rate limits; keep simulated and real-drive results separate.
- Unchanged warm scans do not re-download history bodies; a single edit does not unconditionally re-read all local bodies.
- Exercise concurrent publication, partial indexes, corrupt caches, and write timeouts; all valid versions remain discoverable.
- Publish reproducible before/after evidence. Do not disable hash, parent, or pagination validation to improve speed or promise unsupported instant sync.

## 0.5.0: history and recovery workspace

### Deliverables

- Add a searchable per-file/path timeline on top of existing cloud version lists and local recovery points.
- Show device, ancestry, operation type, and content previews; timestamps remain display information.
- Restore an older cloud version by preserving current content and publishing a new descendant, without rewriting old operations.
- Clarify deleted/renamed history and pending recovery; preview batch restoration.
- Show local staging/recovery storage usage and cleanup previews while protecting active journals, drafts, and unique recovery content.

### Acceptance

- Both devices receive the new restoration result. Edits during restoration stop stale plans and retain content.
- Binary files use complete-version choices; deletion and rename history remain traceable.
- Interrupted batch restoration can resume or end explicitly; unfinished items are not shown as complete.
- Cleanup defaults to a read-only preview and targets only plugin-owned, verified unneeded data. No automatic permanent cloud cleanup.

## 0.6.0: sync scope, languages, accessibility

### Deliverables

- User-defined include/exclude rules with affected-file, reason, and rule-conflict previews.
- Mandatory safety exclusions remain protected. Exclusion is not a deletion signal; re-included paths reconcile again.
- Explain scope changes for existing vaults without default mass deletion on another device.
- Complete English/Chinese UI and language selection with centralized messages and errors.
- Improve small screens, touch, keyboard focus, screen-reader access, and long paths.

### Acceptance

- Cover precedence, Unicode/case behavior, renames, rule changes, differing device rules, and re-inclusion.
- Unchanged rules preserve current defaults. Credentials, state, recovery, and pairing exports cannot become synced notes.
- Every entry point, error, and confirmation has both languages; pairing, conflict, and recovery flows work on narrow screens.
- Any future preference export uses an explicit whitelist/opt-in and excludes runtime identity, queues, baselines, and secret references.

## 0.9.0 RC → 1.0.0: stable acceptance

Freeze features and prioritize fixes. Before 1.0, record:

1. Two devices and two cloud vaults complete installation, upgrade, authorization, pairing, first merge, automatic sync, conflicts, and recovery.
2. Upgrade rehearsals from 0.1.23 and 0.2.0 configuration, cloud data, and local state. If formats change, document preflight and recovery. Explain old-client incompatibility rather than promising unconditional downgrade.
3. At least 7 days on a representative 1,000-file dataset, covering offline concurrent edits, rename, deletion/edit conflict, rate limits, expiry, reload, and recovery; no known valid-version loss, cross-vault writes, or credential exposure.
4. Actual supported/tested platforms, size/merge limits, background limitations, data locations, diagnostics, and recovery instructions.
5. Packages without secrets or notes, consistent metadata, passing CI and public-download verification, with real results tied to exact versions.

Failed RC acceptance means more patches and rechecking affected scenarios. Community availability alone does not establish stability.

## Post-1.0 candidates

| Candidate | Questions to resolve before implementation |
| --- | --- |
| A second provider: WebDAV / S3-compatible / OneDrive, choose one first | Actual demand, authentication/access, pagination/consistency/rate limits, shared adapter contract tests |
| Very large/GB attachments beyond tested large-file profiles | Platform and memory gates still apply; prove capabilities before increasing supported scope |
| End-to-end note encryption | Key derivation/distribution/recovery, metadata exposure, existing-vault migration, compatibility, security review |
| Permanent cloud history cleanup | Reachable versions and retention across devices, offline devices, concurrent publication, previews and revalidation |
| QR/fragmented pairing | Ciphertext size/capacity, verified offline reassembly, expiry/wrong imports without weakening credential protection |
| Optional preference export and device display | Settings whitelist; no runtime identity/queue/baseline migration; historical devices do not imply live presence |

These candidates have no assigned release or implementation commitment. Live collaboration, semantic/AI conflict decisions, developer-managed secrets/account servers, and continuous iPad background transfer are outside this roadmap.

## Iteration process

1. Choose one small verifiable task within a milestone and specify behavior/compatibility changes.
2. Implement on an isolated branch and validate actual risks. Documentation-only changes need content, link, and consistency checks, not invented test counts.
3. Rehearse migration/recovery for format changes, retain benchmarks for performance changes, and identify native device evidence.
4. Update both READMEs, roadmap status, and release notes, distinguishing completed work, gaps, and limits.
5. With release authorization, verify metadata, attachments, and public downloads before updating the community installation target. Isolate previews on separate branches; the prerelease flag alone is insufficient.

**Next: validate 0.2.9 on real repeated/restarted sync and another device's edits, fix findings, then seek community release authorization. Follow with 0.3.x dual-device reliability, 0.4.x attachment memory/chunking, 0.5.x history recovery and 0.6.x scope/languages.**
