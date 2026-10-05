# Case mining log

Mechanical verification: hidden test files copied from solution commit into a worktree at the parent SHA must FAIL, then the same files at the solution SHA must PASS. Both checked with `bun test`.

| sha | test files | verdict | reason |
|---|---|---|---|
| 1c6e50de564199196a79a57990d855b2c0091e80 | tests/advisor-mods-smoke.test.js | KEEP | fail@base, pass@sol (3 files changed, 64 insertions(+), 30 deletions(-)) |
| fe6436a2ec2de7bf4c0dbcf496c60df6e449e5ad | tests/advisor-mods-smoke.test.js | KEEP | fail@base, pass@sol (3 files changed, 65 insertions(+), 4 deletions(-)) |
| fba18a88106014f275efc48532472598ee9b9ded | tests/advisor-mods-smoke.test.js | KEEP | fail@base, pass@sol (3 files changed, 179 insertions(+), 2 deletions(-)) |
| 428fe30bb87898bc6d936091acf961753a461cb4 | tests/advisor-mods-smoke.test.js | KEEP | fail@base, pass@sol (3 files changed, 246 insertions(+), 16 deletions(-)) |
| a38b8e51c4a906db0e90877799ed47ad977ca374 | tests/advisor-mods-smoke.test.js | KEEP | fail@base, pass@sol (3 files changed, 1007 insertions(+)) |
| fd682cd031059d28fe8bbc6c5b0268fab89176df | tests/advisor-mods-health.test.js | KEEP | fail@base, pass@sol (5 files changed, 125 insertions(+), 29 deletions(-)) |
| 229052595bae7f24ce76e4e089c5794f25fef7e3 | tests/advisor-mods-health.test.js | KEEP | fail@base, pass@sol (5 files changed, 461 insertions(+), 4 deletions(-)) |
| d1f8e2fe91be99aec03a85489ae0ef3da94c2318 | tests/close-worker-tab-runner-reap.test.js,tests/observe-nudge-stall.test.js,tests/tmux-runner.test.js | KEEP | fail@base, pass@sol (6 files changed, 469 insertions(+), 14 deletions(-)) |
| 90108633d40fcd7f4d11776d3dd71be516b703aa | tests/advisor-check-brief-paths.test.js,tests/tmux-runner-paneAlive-isolated.test.js | KEEP | fail@base, pass@sol (3 files changed, 32 insertions(+), 2 deletions(-)) |
| d795ad4f9adc9ac3bf034bf327687fba81e5a08f | 4 files | DROP | too many test files |
| 702e26af7e116c9ced514dd2d5977d3bf399f022 | tests/tmux-runner-paneAlive-isolated.test.js,tests/tmux-runner.test.js | KEEP | fail@base, pass@sol (3 files changed, 70 insertions(+), 9 deletions(-)) |
| 5eb4a6afcd79c5e09599024724cb5fe3c023cf8b | tests/summon-advisor-disable.test.js,tests/summon-intelligence-map.test.js | KEEP | fail@base, pass@sol (9 files changed, 87 insertions(+), 57 deletions(-)) |
| 787931d781ac8ab7c6ed4d2a7f7978ece08621f9 | tests/advisor-cost.test.js,tests/summon-audit-fixes.test.js,tests/tmux-runner-pollsentinel-liveness.test.js | KEEP | fail@base, pass@sol (7 files changed, 83 insertions(+), 15 deletions(-)) |
| b1335679c0b5532ec8113647c321a1f9b49c987c | tests/channel-tail-stale-offset.test.js,tests/tmux-runner-pollsentinel-liveness.test.js | KEEP | fail@base, pass@sol (4 files changed, 170 insertions(+), 9 deletions(-)) |
| fced0f96b986794a1119030318cd4c4faef41d25 | tests/summon-audit-fixes.test.js,tests/summon-intelligence-map.test.js | KEEP | fail@base, pass@sol (4 files changed, 174 insertions(+), 11 deletions(-)) |
| eedc8ed0d5c55fc21769e8da4b536d95754b563e | tests/advisor-check-brief-paths.test.js,tests/close-tab-sh.test.js | KEEP | fail@base, pass@sol (4 files changed, 168 insertions(+), 16 deletions(-)) |
| a223f061145eeed973cf9c5746904c43bb7a5010 | tests/advisor-cost.test.js,tests/worker-stop-telemetry.test.js | KEEP | fail@base, pass@sol (5 files changed, 321 insertions(+), 5 deletions(-)) |
| 71f334dddec6010a5481559fae16daf74bebe5be | tests/channel-envelope-string-body.test.js | KEEP | fail@base, pass@sol (5 files changed, 176 insertions(+), 28 deletions(-)) |
| 0360dc37a56148635ee37f3b3aa4022623f7a06f | tests/observe-nudge-stall.test.js | KEEP | fail@base, pass@sol (2 files changed, 237 insertions(+), 22 deletions(-)) |
| 53424ba7755f387f4e03b75c2eff421e6ce17fae | tests/advisor-loop.cli.test.js | KEEP | fail@base, pass@sol (3 files changed, 207 insertions(+), 2 deletions(-)) |
| 8add75f3945e6eca889b7bfdeaa03fa0d659cd10 | tests/multi-sid-observe.test.js | DROP | hidden tests still fail at solution (flaky/env-dependent) |
| 76e3af868042002fa095f93508af9ecc8f2adb50 | tests/vault-lesson.test.js | KEEP | fail@base, pass@sol (2 files changed, 76 insertions(+), 2 deletions(-)) |
| fb5c393cf151432a9a9950a759c4d04ed35cb711 | tests/channel-readall-trailing.test.js | KEEP | fail@base, pass@sol (2 files changed, 88 insertions(+), 13 deletions(-)) |
| 31a83bf468d8eca8771282d7d09d369d73b6edc4 | tests/channel-readafter.test.js,tests/close-worker-tab-worktree.test.js | KEEP | fail@base, pass@sol (4 files changed, 135 insertions(+), 5 deletions(-)) |
| c2589258975df3879de575be389ea1ab6ecd45e9 | tests/worktree-agent-isolation.test.js | KEEP | fail@base, pass@sol (3 files changed, 185 insertions(+), 15 deletions(-)) |
| 94eaa57caa081bfc76adf76f0af5e37b71c6c49f | tests/channel-verdict.test.js | KEEP | fail@base, pass@sol (2 files changed, 75 insertions(+), 2 deletions(-)) |
| 77f601ec8dd6619cf9ad6f3c6ddfea6b0365c33c | tests/advisor-check-brief-paths.test.js | KEEP | fail@base, pass@sol (2 files changed, 117 insertions(+), 8 deletions(-)) |
| c3dccc05bf9ef9363676d0745f6d6d649f079c0e | tests/advisor-check-brief-paths.test.js | KEEP | fail@base, pass@sol (2 files changed, 207 insertions(+), 7 deletions(-)) |


Kept: 26 / attempted: 31 (scanned up to first 50 eligible-shaped commits)
