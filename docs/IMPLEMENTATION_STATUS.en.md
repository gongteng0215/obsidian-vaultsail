# Implementation status — 2026-10-20

Local preview **0.2.23** addresses review compatibility findings: zero local lint errors/warnings, 289 automated checks passing, and byte-identical build output from a source archive with fresh dependencies and no `.git`. See [changes and verification](releases/0.2.23.md). It has not been published or submitted for review; 0.2.22 below remains the public release.

GitHub release: **0.2.22**, published on 2026-10-20. Official preview: Completed; release scan: Completed. See [publication evidence](releases/0.2.22-publication.md). Real-device acceptance remains pending.

| Evidence level | Status |
| --- | --- |
| Implemented | Automatic per-vault queue, preserved versions/conflicts/recovery, empty folders, persistent scan caches, transfer center, cloud file tree with deleted paths hidden and files as leaves |
| Implemented in 0.2.22 | Separate file/directory metrics, persisted request categories/task type, truthful parallel-preflight status, invalidated/paused check guards, deterministic fixtures and marker-gated read-only native verifier, independent special reports |
| Simulation passed | 282 automated checks and integrity/queue/lifecycle/privacy regressions and paired 7/100/1000-file benchmarks; see [release evidence](releases/0.2.22.md) |
| Native verified | Only package/installation asset consistency can be checked locally in this delivery; this does not validate native sync |
| Pending | Real Baidu speed, Windows/iPad bidirectional Hash agreement, two devices/two destinations, 20 lifecycle cycles, 7-day observation and natural authorization renewal |

Desktop whole-buffer maximum is 512 MiB (20–512 configurable); mobile is 20 MiB. File concurrency defaults to 8 (1–32), desktop slice concurrency to 2 (1–4), mobile to 1. Existing values and opt-in deletion/automatic-sync preferences are preserved.

Next: complete [native acceptance](acceptance/0.2.22.md) before the 0.3.0 candidate; document at least seven days of use and actual renewal if triggered. Keep renewal pending if it has not occurred. Then evaluate 0.4.x large-file memory/chunked I/O, 0.5.x cloud history/restore, and 0.6.x scope, languages and accessibility. Historical Chinese status entries below the current summary remain historical.
