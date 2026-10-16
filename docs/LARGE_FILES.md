# VaultSail large-file sync implementation plan

**English** | [简体中文](LARGE_FILES.zh-CN.md) · [Roadmap](ROADMAP.md) · [Current capabilities](../README.md#feature-inventory)

Date: **2026-10-16**. Design baseline: **0.2.0**. Progress: **0.2.1 preview implements L0 local preflight, blocked-file handling, and on-demand chunk bodies**, with [validation/limits](releases/0.2.1.md). Later stages remain unimplemented design. The cap stays 20 MiB without a cloud format migration; native acceptance is pending. Version assignments below are conditional targets, not dates or supported-size promises.

## 1. Recommendation and goals

Deliver in order: isolate oversized files, remove unnecessary copying, prove platform capabilities, cautiously raise limits, then add bounded chunk I/O and resumable transfer. Prioritize normal notes while large attachments remain pausable and recoverable.

Focus first on PDFs, scans, and images. Use external drive links for very large videos, disk images, and archives for now; GB-scale cross-device sync is not promised.

Success means:

- A recognized file outside this device's policy does not block unrelated ordinary files.
- The existing user concurrency ceiling remains, default 8; initially only one large file runs, constrained by memory and request budgets.
- Stable source snapshots, staging, recovery, and version records agree.
- Only verified content becomes a valid version or replaces a local file.
- Controlled buffers in a genuinely streaming path do not scale linearly with total file size. Full-buffer paths remain explicitly labeled.
- Account/application/directory/vault changes cannot redirect old tasks. Pairing never migrates checkpoints, temporary URLs, or queues.

## 2. Current implementation

| Location | Current behavior | Required change |
| --- | --- | --- |
| `src/core/safety.ts` | Shared 20 MiB `checkSize()` | Separate logical sizes, body-buffer policy, and metadata limits |
| `src/platform/obsidian-adapters.ts` | Full `ArrayBuffer` reads; staging/recovery/application re-read content | Metadata-first inventory, snapshot and chunk capabilities |
| `src/providers/baidu-provider.ts` | Existing 4 MiB upload chunks, all copied with `slice()` before multipart creation | Produce only needed chunks and release them |
| `src/providers/http.ts` and the Obsidian transport | Downloads return complete response buffers | Bounded, cancellable large-file transport |
| `src/core/concurrency.ts` | Default 8, range 1–32, approximately 24 MiB logical batches | Logical bytes are not a hard process-memory ceiling |
| `src/sync/engine.ts` | Whole-body hashing, staged/recovery copies | Classify before body reads; include conflict/recovery paths |
| `src/sync/remote-vault.ts` | Revision logical sizes also use the 20 MiB check | Reader compatibility before publishing larger records |

Chunked upload already exists. It does not establish low-memory sync or restartable upload. Downloads, hashing, snapshots, conflict copies, and final verification are part of the same problem.

## 3. Delivery stages

| Stage | Conditional version | Deliverable | Boundary |
| --- | --- | --- | --- |
| L0 | Later 0.2.x stabilization patch | Metadata-first classification, blocked-file list, partial results, small-file continuation, on-demand chunk copies | Keep 20 MiB; no oversized records |
| L1 | 0.3.x platform validation | Desktop/iPad I/O prototypes, logical-size versus device-policy separation, memory/disk benchmarks | Controlled testing and compatible readers first |
| L2 | 0.4.x after L1 | Configurable limits on tested platforms, one large file, budgeted full-buffer path | Default 20 MiB; opt-in increases, untested devices retain limits |
| L3 | Later 0.4.x or separate preview after capability gates | Chunked desktop snapshots, upload/download, incremental hashing, persistent recovery | Desktop first; independent iPad qualification |
| L4 | 0.5.x recovery experience or later | Checkpoint management, storage accounting, retry/cleanup previews | Integrate recovery without permanent cloud cleanup |

Skip the L2 size increase if full-buffer measurements fail; wait for L3. The mainline still starts with 0.2.1 stabilization. Desktop results do not unlock mobile support automatically.

## 4. Settings and user flow

| Setting | Initial policy | Validation |
| --- | --- | --- |
| Device transfer limit | Keep 20 MiB, later expose tested profiles | Integer/range/platform/path checks; no unlimited option |
| Large-file concurrency | Initially fixed at 1 | Counts toward existing total ceiling |
| Automatic large-attachment sync | Off when introduced | Preview/manual opt-in before enabling |
| Large-file classification | Initially above 20 MiB | Separate from transfer cap, provider chunk size, and merge budget |
| Controlled memory budget | Determined by platform evidence | Wait/block rather than exceed; no arbitrary user value initially |
| Staging/recovery usage | Show active and safely reclaimable data | Protect live journals, drafts, and unique recovery content |

50, 100, and 200 MiB are benchmark candidates, not approved settings. Determine actual profiles from measurements, not device-name assumptions. Existing concurrency stays 1–32, default 8. New preferences are device-local and do not implicitly migrate through pairing or change bindings.

Flow: inventory metadata → classify supported and blocked files → prioritize small files → schedule eligible large work → report completed/skipped/intervention counts. Blocked items live in a separate visible registry, re-evaluated on changes, policy/capability updates, or manual retry rather than every debounce cycle.

Do not automatically rewrite attachment links or create placeholder files that resemble real attachments.

## 5. Architecture and interfaces

```text
Events / manual sync
        ↓
Metadata inventory → capability/policy decision → blocked-file registry
        ↓ eligible files
Fair scheduler: total slots + large-file slot + byte credits
        ↓
Stable snapshot → incremental hash → resumable transfer → full verification
        ↓
Immutable publication OR protected local application
        ↓
Serialized baseline and journal commit
```

Proposed responsibilities:

- `LocalFileIO.stat()`: size/type/change hints without reading bodies. Size/mtime do not prove content identity.
- `LocalSnapshot`: operation-scoped stable staged source with size, digest, and chunk reads.
- `TransferCapabilities`: separate bounded upload, download, hashing, snapshot, recovery, and commit capabilities, rather than one misleading streaming flag.
- `BinarySource` / `BinarySink`: offset reads and chunk writes/append/finish. Verify that implementations do not load everything internally.
- `TransferBudget`: reserve before allocations/requests and release after the last consumer.
- `ResumableTransfer`: session, acknowledgements, remote verification, and recovery.
- `LargeFileJournal`: scoped identity, snapshot, object, and stages, without credentials/URLs/bodies.
- `BlockedFile`: policy/capability/disk conditions; never downgrade malformed history or integrity errors into ordinary skips.

Keep bounded small-file adapters. Large-file paths cannot secretly call legacy whole-buffer `read()` / `blob()`, including during conflict preservation and restoration.

## 6. Inventory, skips, and baselines

Represent at least four states:

| State | Meaning | Deletion implications |
| --- | --- | --- |
| `missing` | Complete enumeration confirmed absence | Still requires trustworthy baseline and deletion policy |
| `present-readable` | Present and verifiable this pass | Normal version comparison |
| `present-blocked` | Present, but over limit/disabled/unsupported | Never infer deletion |
| `unknown` | Incomplete listing or failed read | Never infer deletion; block unsafe writes |

Validate paths/collisions before body reads. Retain skipped-file baselines and existence. A valid remote large-file revision may join the graph while its local application/baseline is frozen. Freeze related identities and rename paths too, while allowing independent files.

Separate discovered operations from verified applied content. Cached metadata cannot mark an undownloaded attachment complete. Do not turn a blocked file into rapid recurring work. Pagination, unknown formats, missing parents, rewritten records, and unsafe paths retain their safety behavior.

## 7. Memory, disk, and fairness

Remove eager chunk copies first. Generate only current request bodies; compute block MD5s incrementally and retain digests. A `subarray()` view still keeps its backing buffer alive.

Full-buffer estimates include source, old destination, download/readback responses, request bodies, decoding/hash temporaries, and completed jobs waiting for serialized commit. Calibrate conservative estimates with measurements; 24 MiB logical batches are not 24 MiB RSS.

For bounded paths:

```text
controlled buffers ≈ in-flight chunks × (read + request + response buffers)
                   + digest/journal overhead + pending-commit buffers + margin
```

Acquire credits before allocation and retain them until all consumers finish. Garbage collection, native HTTP buffers, and OS memory require real measurement; accounting is not a hard process-memory guarantee. Initially use one large file and sequential provider chunks, using the existing 4 MiB Baidu chunk as a prototype parameter subject to actual API/application verification.

Prioritize small work but grant large work a scheduling turn to avoid starvation. Count all metadata and chunk requests under coordinated limits, not files multiplied by per-file parallelism. Edits create later work, never mutate the in-flight snapshot. Backoff honors provider waits; unknown writes are verified before retry.

The existing engine gates planning on unfinished journals. Sorting by size alone cannot provide fairness. L3 needs per-file/identity/old-and-new-path transfer leases and persisted checkpoints so independent files can use the same coordinator while shared state commits serially. Re-test existing recovery protection rather than deleting it. Global safety failures may still stop everything.

Promise timeout is not native request completion. Retain budget, serialization, and in-flight accounting until actual completion or confirmed cancellation, including across plugin reload. Transports unable to enforce this cannot qualify for large-file support.

Disk estimates include upload snapshot, download staging, old-target recovery, and crash leftovers. Preflight reliable free-space data where available; otherwise show estimates and handle write failure without losing originals. Cleanup targets only verified plugin-owned paths, never arbitrary temp/state files.

## 8. Snapshot and upload

1. Capture local/remote basis and device/account/application/directory/vault context.
2. Create an immutable local snapshot while incrementally hashing SHA-256 and provider block digests.
3. Observe mutation generations and before/after identity/stat hints. On detected mutation, short read, or identity change, discard unconfirmed capture and requeue. Size/mtime are not substitutes for hashing.
4. A full-buffer snapshot is allowed only under a tested cap. Unsupported mobile snapshot/concurrent-write semantics cannot be called large-file support.
5. Stable snapshot determines `blobs/<whole-file-sha256>`. Persist journal before creating upload sessions; final addressing requires content identity first.
6. Upload required blocks and verify acknowledgement digests before checkpointing. MD5 serves the provider protocol; SHA-256 identifies content.
7. Commit and validate path, size, and identity. A lost commit response requires final-object verification before resubmission.
8. Read back the object through a bounded path and verify full SHA-256. Reuse prior verification only after fresh metadata proves the same object.
9. Publish the immutable operation only after verified content; retain the operation ID for retries of this snapshot.
10. Revalidate ancestry around publication. Preserve concurrent branches. Further local edits remain queued; snapshot publication does not imply current local content is synchronized.

Without reliable cross-process source locking, do not promise atomic snapshots against arbitrary external writers. Prove the available strategy. Otherwise restrict the platform to a controlled manual stable-file workflow, stopping on detected changes.

## 9. Download and local application

1. Capture version, object identity/size/SHA-256, and expected local content.
2. Obtain a permitted short-lived official URL, kept in memory; revalidate identity after URL/token renewal.
3. Require actually bounded, cancellable transport. A normal full-buffer `requestUrl` response is not an unlimited-file stream.
4. For range requests validate `206`, exact `Content-Range` and total size, response length, and consistent identity. Handle `416`, truncation, representation compression, and expired links. `Accept-Ranges` alone is insufficient.
5. If Range is ignored with `200`, abort within budget only on a capable streaming channel. A buffered channel may have allocated the entire file before checking status; post-response rejection is not a large-file fallback.
6. Use conditional ranges only with suitable strong validators. Arbitrary provider MD5s or weak ETags are not automatically valid `If-Range` inputs. Restart if consistency is uncertain; final SHA-256 must pass.
7. Write confirmed contiguous data to staging. After restart, re-read and validate the prefix rather than trusting length/bitmaps. Do not rely solely on serialized hash-library internals.
8. Validate staged size/hash and unchanged target, then create verified recovery content.
9. Apply using a platform-tested commit protocol, keeping Vault indexing/events/cache coherent. Raw rename alone does not prove Obsidian consistency.
10. Verify applied content before baseline commit. Crash stages must distinguish original, staging, and result.

Backup then write is not universally atomic compare-and-swap. Test concurrent edits between final check and replacement. Where guarantees are insufficient, disallow automatic large-file replacement and use a controlled manual completion flow or remain unsupported. Never advance baseline after a hash warning.

## 10. Resume journal

Add a migrated device-local transfer journal alongside operation journals, excluded from cloud records and pairing:

| Group | Stored data |
| --- | --- |
| Scope | Schema, device/vault/connection fingerprints, operation ID, direction, file identity |
| Source | Relative path, snapshot ID, logical size, SHA-256, expected local hash, parents |
| Upload | Protected session reference, chunk size/digests, confirmed status |
| Download | Staging ID, verified contiguous length, object identity, segment checks |
| Stage | Snapshot prepared, transferring, final object uncertain, content verified, record published, applying, baseline committed |
| Scheduling | Safe error class, retry time, pause reason; no credentials or bodies |

Treat upload IDs as session capability data: use SecretStorage/protected local session storage. If unavailable, abandon that session on restart and obtain a new one; do not export IDs to diagnostics. Never persist access/refresh tokens, secrets, signed URLs, headers, or bodies in journals.

Recovery validates scope/format/staging and binding first. Local acknowledgements do not prove provider retention: use only actually supported official verification methods, not an assumed uploaded-parts endpoint. Resume verified sessions or create a new session for the same snapshot and operation ID. Uncommitted old parts never become valid notes.

Verify uncertain object/record publication before repeating it. Existing identical results advance to the next stage; different content is an integrity error. Interrupted application compares old/new/staged fingerprints and recovery data. Ending tasks stops retries but preserves recoverable content. Cleanup needs a separate preview.

Serialize journal writes with recoverable temp/replace steps. New journals can make old-client downgrade unsafe; preserve state on upgrade and document supported completion/recovery before downgrade.

## 11. Cloud format and old clients

Prefer existing `vault.json + blobs/<whole-file-sha256> + ops`. Provider upload chunks remain a transport detail, without new cloud chunk manifests or one operation per chunk.

**0.2.0 rejects revisions declaring sizes above 20 MiB.** Keeping schema 1 does not make oversized records compatible with those readers; an older device can stop its entire scan.

1. Separate safe logical-size validation, device transfer policy, and metadata-object limits. Logical sizes require nonnegative safe integers and a fixed protocol ceiling independent of user settings.
2. Ship compatible readers first: recognize supported large descriptors, show blocked files, continue independent files, but do not yet publish oversized records.
3. Keep protocol, metadata bytes, record count, and ancestry bounds independent. Attachment increases cannot relax JSON/journal safety.
4. Before opt-in publication, explain every participating device needs compatible readers, including offline devices. Historical device lists cannot prove all clients upgraded.
5. Existing-vault opt-in requires explicit choice. If compatibility is uncertain, leave disabled or use a separate new cloud vault; do not automatically migrate existing data.
6. Do not remove immutable history to downgrade. Deleting the current attachment does not remove oversized historical records from old parsers.

Any future cloud chunk manifest or new commit semantics needs a separate schema-migration proposal. New size/automatic-sync preferences do not implicitly migrate through account pairing.

## 12. Desktop and iPad gates

| Capability | Desktop prototype | iPad prototype | Failure behavior |
| --- | --- | --- | --- |
| Read | Vault-scoped chunk access with path/identity checks | Prove supported public I/O/resource access is truly chunked; no desktop Node assumptions | Retain full-buffer cap |
| Stage/recover | Chunk writes/copies/verification and index coherence | Test append/write/restart/background behavior | No automatic large application |
| Network | Bounded/cancellable requests and Range | Verify official hosts, CORS/redirects, suspension, cancellation | No whole-file fallback |
| Commit | Recoverable replacement and concurrent edits | Verify native file/Vault index/events | Controlled manual completion or unsupported |
| Measurement | JS/native process memory, disk, requests | Native evidence and stability | Unknown rather than proven bounded |

Official binary reads return `ArrayBuffer`; `appendBinary` is marked since **1.12.3**, whereas the plugin minimum is **1.11.4**. Do not call newer APIs unconditionally while claiming the old minimum. [Official API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

L0 retains the minimum. Later either gate affected features by capability/version or explicitly raise `minAppVersion` and update `versions.json`. No silent degradation.

## 13. Errors and progress

Distinguish waiting for a large slot, memory credits, disk space, file policy, platform capability, reader compatibility, backoff, expired sessions, changed source/object, integrity failures, and pending application recovery.

Separate sent/received bytes, verified bytes, and completed files. Show preparation, transfer, readback, and application independently. Upload completion alone is not file completion. Oversize is a blocked state, not a network error. Safe step/class messages replace raw exceptions that might leak URLs or credentials.

## 14. Validation matrix

Use generated chunk sources, controlled transports, and injected failures. Do not prove low memory by first allocating the entire large fixture. Native tests use isolated non-private data.

| Category | Scenarios | Acceptance |
| --- | --- | --- |
| Boundaries | Empty, chunk edges, 20 MiB edges, 50/100/200 MiB candidates | Correct classification, matching supported hashes, visible unsupported items |
| Mixed queue | 100 small files plus blocked/large files, ongoing edits | Small progress, fair large progress, no lost work or busy retry loop |
| Inventory | Local/remote policy block, linked renames, exclusions, incomplete lists | No false absence/deletion/baseline advancement |
| Memory | Growing file sizes, concurrency 1/8/32, pending commits | Bounded paths do not retain full size; buffered paths stay within tested profiles |
| Upload recovery | Chunk boundaries, session expiry, lost commit, record publication | Verify outcomes, no duplicate valid operations or unverified versions |
| Download | `206/200/416`, wrong/truncated ranges, changing object, expired links | No mixed objects or hidden buffering, final SHA-256 correct |
| Local safety | Capture/commit edits, full disk, write failure, restart | Originals/recovery retained, edits not silently lost |
| Conflicts/history | Concurrent PDFs, keep both, restore older cloud version | Whole-version handling without hidden full-body allocation |
| Compatibility | Old 0.2.0, compatible readers, restricted iPad, opted-in vaults | Document actual old-client failures and migration preflight |
| Lifecycle | Reload, 20 foreground transitions, reconnect, account/vault switch | Serialization and stale-response isolation |
| Privacy | Settings/journals/diagnostics/pairing/package | No credentials, session secrets, signed URLs, or note bodies |

Run at least 10 roundtrips for each proposed profile, recording platform/version, source size, measured memory/disk peaks, requests, throughput, verification duration, and recovery outcomes. No iPad profile without native evidence. Credit counters cannot substitute for process-memory measurement; unknown stays unknown. Packages retain only the three plugin files.

## 15. Reviewable implementation tasks

| ID | Task | Depends on | Deliverable |
| --- | --- | --- | --- |
| LF-01 | Split policies and metadata-first inventory | None | Limit responsibilities, blocked-presence semantics, boundary regressions |
| LF-02 | Blocked registry, partial results, wake conditions | LF-01 | Independent small files, no false deletions/retry loops |
| LF-03 | On-demand chunks and buffer lifetime audit | None; test within 20 MiB | Memory comparison and integrity coverage |
| LF-04 | Platform I/O/network/commit prototypes | LF-01 | Supported/unsupported evidence, no immediate size increase |
| LF-05 | Compatible readers and upgrade preflight | LF-01, LF-02 | Reader isolation and documented old-client behavior |
| LF-06 | Snapshot, incremental digests, budgets | LF-03, LF-04 | Bounded capture and mutation detection |
| LF-07 | Upload sessions, readback, recovery | LF-05, LF-06 | Fault injection, expiry and uncertain results |
| LF-08 | Range/stream download, staging, safe apply | LF-04, LF-06 | Range/disk/commit-window validation |
| LF-09 | Sync/conflict/recovery integration and settings | LF-07, LF-08 | Tested profiles, no hidden whole-buffer paths |
| LF-10 | Native acceptance and staged release | LF-09 | Device reports, packages, migration/recovery instructions |

L2 buffered profiles can be evaluated after LF-04/LF-05, but must include conflict, readback, recovery, and old-target peaks. Values are published only with evidence.

**The local preflight, blocked-file, and on-demand chunk scope of LF-01 through LF-03 is implemented in preview 0.2.1, with 168 automated checks and the 20 MiB cap retained.** Blocked paths are session-local last successful scan results. Remote-reader size separation, native memory acceptance, and full chunk I/O remain unimplemented. Validate this build before LF-04 platform prototypes and higher-limit decisions.

## 16. Sources and unresolved gates

- Current repository files above establish 0.2.0 behavior; the cap is a plugin choice, not Baidu's universal limit.
- [Official Obsidian API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts): binary types, append API, version annotations; not proof of iPad streaming.
- [Baidu Netdisk SDK](https://github.com/baidu-netdisk/baidu-drive-sdk-go): precreate/chunk/commit/download reference; not proof of application permissions or JS/iPad support.
- [HTTP RFC 9110 ranges](https://www.rfc-editor.org/rfc/rfc9110.html#name-range): protocol rules; not proof every Baidu endpoint supports them.

Prototype gates remain: actual upload/resume permissions, download ranges/validators, bounded mobile I/O/cancellation, commit guarantees, measured memory/disk peaks. Until proved, do not raise defaults, promise GB support, or introduce third-party credentials/developer servers.
