# F2 Results — Fuzzy-Confidence Ownership Lookup, Built and Exercised for the First Time

Date: 2026-08-19/20 · Seat: CENTRAL · Follow-on to G5 (`02-forge/results/G5_RESULTS.md`)

Reuses the same local Postgres (`central-mvp-pg`, port 5433, schema `controlplane`) and Redis
(`central-mvp-redis`, port 6380) containers from G5 — neither was recreated, both were already
`Up` (2h uptime) when this gate started. Reuses `03-daemon/ingest.mjs` → Redis →
`03-daemon/dispatcher.mjs` unmodified in shape, only the ownership-lookup internals changed.

**What this gate actually builds, not just tests.** G5's ownership lookup was
**exact-match-only** (`003_ownership.sql`'s own header comment: "deliberately exact-match
only"). `confidence` in G5 was therefore always exactly `1.0` (a row existed) or the row simply
didn't exist — there was no partial-match concept, and G5's own §7/§9 said so explicitly: *"the
code path for … a matched row whose confidence still falls under `confidence_threshold` …
exists … but was not separately exercised … exact-match-only lookup means every match in this
MVP is confidence 1.0 by construction."* This gate builds the missing piece — trigram fuzzy
matching via `pg_trgm` — and exercises both sides of the threshold comparison for the first
time with real, computed similarity scores.

**Overall: PASS.** The below-threshold fuzzy case was correctly suppressed — zero worker
processes, zero `worker_dispatch_result` rows, logged to `unrouted_errors` with a real (not
NULL) similarity score. The above-threshold fuzzy case correctly spawned one real read-only
worker in the correct directory, with a real session id, real cost, and a real result logged.

---

## 1. What was built

| Piece | File | Role |
|---|---|---|
| pg_trgm extension + fuzzy function | `02-forge/sql/005_fuzzy_ownership.sql` | `controlplane.lookup_owner_fuzzy(text)`, GIN trigram index, 1 new seed row |
| Dispatcher ownership lookup | `03-daemon/dispatcher.mjs` | `lookupOwnership()` now calls the SQL function instead of a bare `WHERE project_id =` |
| Dispatcher routing decision | `03-daemon/dispatcher.mjs` (`handleItem`) | `confidence` is now `owner.similarity_score` (real, computed) instead of a hardcoded `1.0`/`0.0` |

### 1a. `pg_trgm` extension

Confirmed **not** already enabled before this gate:
```
$ psql ... -c "select extname, extversion from pg_extension order by extname;"
 extname | extversion
---------+------------
 plpgsql | 1.0
```
Enabled with `CREATE EXTENSION IF NOT EXISTS pg_trgm;` (ships in `postgres:15-alpine`'s
standard contrib modules, as the task briefing predicted — no image rebuild needed):
```
 extname | extversion
---------+------------
 pg_trgm | 1.6
 plpgsql | 1.0
```

### 1b. `controlplane.lookup_owner_fuzzy(incoming_project_id text)`

Returns at most one row: an exact match scored `1.0` (`match_type='exact'`) if one exists;
otherwise the single best `pg_trgm similarity()` candidate against every seeded `project_id`
and its **real** score (`match_type='fuzzy'`). The function's job is only to report the best
match and its score — the caller (`dispatcher.mjs`) decides routability by comparing that score
to the matched row's own `confidence_threshold`. Full SQL: `02-forge/sql/005_fuzzy_ownership.sql`.
A GIN trigram index (`project_ownership_trgm_idx`) was added too — not required for correctness
at 4 rows, but a function that claims to use `pg_trgm` should actually be indexed for it.
`EXECUTE` granted to `controlplane_ai_writer`/`controlplane_approver` (read-only, same
least-privilege posture as G5's `SELECT` grant on the table itself).

### 1c. Dispatcher wiring

```js
const owner = await lookupOwnership(project_id);          // now calls lookup_owner_fuzzy()
const confidence = owner ? owner.similarity_score : 0.0;   // REAL number, not a constant
const threshold  = owner ? owner.confidence_threshold : 0.9;
const routable   = !!owner && confidence >= threshold;     // same comparison G5 always had
```
This is the exact `routable = exact_match OR (fuzzy_match AND confidence >= threshold)` logic
the task specified — `owner` is non-null and `confidence` is `1.0` for an exact match (always
clears any real-world threshold ≤1.0), or `owner` is non-null with a genuine fuzzy score that
must independently clear the threshold. `03-daemon/dispatcher.mjs` on disk reflects this.

## 2. Seeded near-miss row + how the two test `project_id`s were constructed

**New row**, a genuine near-miss of the existing `myi2` row, pointing at the **same** real
`MYI2` directory (one project, two plausible identifiers a monitoring system might send):

```sql
insert into controlplane.project_ownership (project_id, project_name, local_directory, confidence_threshold)
values ('myi2-app-service', 'MYI2', '/Users/celeste7/Documents/MYI2', 0.9);
```

Deliberately **not** the task's own literal `'myi2-app'` example — that exact 8-character
string trigram-caps a single-character-insertion typo's similarity at precisely `0.90`
(verified empirically by brute-forcing every 1-character substitution/insertion/deletion of
`'myi2-app'` against itself and taking the max non-boundary-artifact score — see raw sweep
below). `0.90` is not "clearly above" a `0.9` threshold and would leave the ABOVE-threshold
case sitting exactly on the boundary, at the mercy of float rounding. `myi2-app-service`
(17 chars) was chosen instead specifically because a longer base string leaves more room: the
same style of single-character typo lands at `0.9444`, comfortably clear of `0.9`.

**Final `project_ownership` (4 rows):**
```
    project_id    |  project_name   |              local_directory              | confidence_threshold
------------------+-----------------+--------------------------------------------+----------------------
 celeste-os       | CelesteOS-Cloud | /Users/celeste7/Documents/CelesteOS-Cloud  |                  0.9
 influence        | INFLUENCE       | /Users/celeste7/Documents/INFLUENCE        |                  0.9
 myi2             | MYI2            | /Users/celeste7/Documents/MYI2             |                  0.9
 myi2-app-service | MYI2            | /Users/celeste7/Documents/MYI2             |                  0.9
```

**Test `project_id`s were chosen by directly measuring `similarity()` against every seeded row**
(not guessed) — full cross-check, run before either payload was sent:
```sql
select cand, seeded, similarity(cand, seeded) as sim
from (values ('influence-legacy'),('myi2-appp-service')) as c(cand)
cross join (values ('celeste-os'),('influence'),('myi2'),('myi2-app-service')) as s(seeded)
order by cand, sim desc;
```
```
       cand         |      seeded      |     sim
--------------------+------------------+-------------
 influence-legacy   | influence        |   0.5882353
 influence-legacy   | myi2-app-service |   0.0303030
 influence-legacy   | celeste-os       |           0
 influence-legacy   | myi2             |           0
 myi2-appp-service  | myi2-app-service |   0.9444444
 myi2-appp-service  | myi2             |   0.2777778
 myi2-appp-service  | influence        |   0.0370370
 myi2-appp-service  | celeste-os       |           0
```

- **`influence-legacy`** — shares only the prefix `influence` with the seeded `influence` row
  (compound word, not a typo, per the task instruction "not near-identical"). Best match
  similarity **0.5882353** — squarely inside the requested 0.5–0.7 band, unambiguously the
  best candidate over every other seeded row.
- **`myi2-appp-service`** — a one-character-insertion typo (extra `p`) of the newly seeded
  `myi2-app-service`. Best match similarity **0.9444444** — clearly above the 0.9 threshold,
  unambiguously the best candidate.

Neither string is an exact match of any seeded `project_id` — confirmed by the `match_type`
the function itself returned (`'fuzzy'` in both cases, not `'exact'`), not assumed.

## 3. Pre-flight baseline (before either payload was sent)

```
$ redis-cli -p 6380 LLEN errors:incoming            → 0
$ ps aux | grep -i stream-json | grep -v grep        → (zero matching processes)
$ select count(*) from controlplane.events
    where body->>'project_id' in ('influence-legacy','myi2-appp-service');   → 0
$ select count(*) from controlplane.unrouted_errors
    where project_id in ('influence-legacy','myi2-appp-service');            → 0
```
Same evidence discipline as G5: queue empty, zero worker processes, zero pre-existing rows for
either test `project_id` — any post-run row is attributable to this run alone.

## 4. The pipeline run — exact payloads, in order

Ingest server started: `node ingest.mjs --port 8899`. Health check: `{"ok":true,"service":"g5-ingest","redis_port":6380,"list":"errors:incoming"}`.

### Payload 1 — LOW fuzzy confidence, `influence-legacy` (MUST be suppressed)
```json
{
  "project_id": "influence-legacy",
  "culprit": "unknown/service/legacyDashboardProxy in fetchMetrics",
  "exception_type": "ConnectionError",
  "exception_value": "F2 test: fuzzy match against 'influence' expected similarity ~0.588 (well below 0.9 threshold) -- MUST be suppressed",
  "stack_frames": [{"filename": "unknown/service/legacyDashboardProxy.js", "function": "fetchMetrics", "lineno": 41}]
}
```
`curl -X POST http://localhost:8899/ingest` → `{"ok":true,"queued":true,"list_len_after_push":1}`

### Payload 2 — HIGH fuzzy confidence, `myi2-appp-service` (MUST route to a real worker)
```json
{
  "project_id": "myi2-appp-service",
  "culprit": "src/handlers/policyHandler.py in renew_policy",
  "exception_type": "KeyError",
  "exception_value": "F2 test: fuzzy match against 'myi2-app-service' expected similarity ~0.944 (above 0.9 threshold) -- MUST route to a real worker in MYI2",
  "stack_frames": [
    {"filename": "src/handlers/policyHandler.py", "function": "renew_policy", "lineno": 55},
    {"filename": "src/services/renewals.py", "function": "apply_terms", "lineno": 22}
  ]
}
```
`curl -X POST http://localhost:8899/ingest` → `{"ok":true,"queued":true,"list_len_after_push":2}`

Redis list confirmed to hold exactly 2 items post-POST (`LLEN` → `2`), content verified via
`LRANGE 0 -1` before the dispatcher touched it — proving the HTTP→Redis leg independent of the
dispatcher, same as G5 §4.

## 5. Dispatcher run — full transcript (`node dispatcher.mjs --count 2 --wait 8`)

```
[dispatcher] starting — will process up to 2 item(s) from "errors:incoming", BRPOP timeout 8s each

──────────────────────────────────────────────────────────────
[dispatcher] item #1  project_id=influence-legacy  culprit=unknown/service/legacyDashboardProxy in fetchMetrics
[dispatcher] ps proof (before decision): 0 claude stream-json process(es) running
[dispatcher] ownership lookup: FUZZY MATCH → INFLUENCE @ /Users/celeste7/Documents/INFLUENCE (score=0.5882, threshold=0.9)
[dispatcher] confidence=0.5882 threshold=0.9 → FALLBACK (unroutable)
[dispatcher] would-be spawn suppressed — reason=confidence_below_threshold (fuzzy match scored 0.5882 < threshold 0.9). NOT spawning any worker. NOT touching any directory.
[dispatcher] logged to controlplane.unrouted_errors id=430c8732-e4ef-4f31-a80f-76e5474c66cc status=needs_human_review
[dispatcher] ps proof (after suppression): 0 claude stream-json process(es) running

──────────────────────────────────────────────────────────────
[dispatcher] item #2  project_id=myi2-appp-service  culprit=src/handlers/policyHandler.py in renew_policy
[dispatcher] ps proof (before decision): 0 claude stream-json process(es) running
[dispatcher] ownership lookup: FUZZY MATCH → MYI2 @ /Users/celeste7/Documents/MYI2 (score=0.9444, threshold=0.9)
[dispatcher] confidence=0.9444 threshold=0.9 → ROUTE (happy path)
[dispatcher] SPAWNING worker role=probe cwd=/Users/celeste7/Documents/MYI2
[worker] ready session=cb1f6c81 tools=30
[worker] done turns=1 cost=$0.0206 error=none
[worker] result: The most likely file to investigate first is `src/handlers/policyHandler.py`, specifically in the `renew_policy` function where the KeyError is occurring—the exception value appears to be a test string being used as a dictionary key somewhere in that function.
[dispatcher] ps proof (after worker exit): 0 claude stream-json process(es) running

[dispatcher] === SUMMARY === processed 2/2 item(s)
  - influence-legacy: fallback (reason=confidence_below_threshold, unrouted_id=430c8732-e4ef-4f31-a80f-76e5474c66cc)
  - myi2-appp-service: route (session=cb1f6c81, cost=$0.0206)
```
Full unedited output preserved at `02-forge/results/f2_dispatcher.log`.

Redis queue confirmed empty after the run (`LLEN` → `0`) — both items consumed exactly once.

## 6. Proof the LOW-confidence fuzzy case spawned NOTHING

Same three-kind evidence discipline as G5 §6:

**(a) Architectural.** `new Worker(...)` still appears exactly once in `dispatcher.mjs`, inside
`if (routable)`. `influence-legacy`'s `routable` evaluated `false` (`0.5882 < 0.9`), so the
`else`/fallback branch ran — the branch that never references `Worker` at all.

**(b) `ps` snapshots.** Immediately before and after the `influence-legacy` decision:
```
0 claude stream-json process(es) running   (before)
0 claude stream-json process(es) running   (after)
```
Post-run global check, after the dispatcher itself had exited:
```
$ ps aux | grep -i "stream-json" | grep -v grep
(no output — zero claude worker processes of any kind running)
```

**(c) Database-level absence.**
```sql
select count(*) from controlplane.events
  where kind='worker_dispatch_result' and body->>'project_id'='influence-legacy';
```
→ **`0`**. No `session_id` was ever minted for `influence-legacy`. The one `unrouted_errors`
row for it carries the **real, non-NULL** computed confidence — closing the exact gap G5 §7
flagged (*"a candidate scored below threshold … would have stored a numeric confidence"*, never
exercised until now):
```
                  id                  |    project_id     |           reason           | matched_confidence |       status
--------------------------------------+--------------------+-----------------------------+---------------------+---------------------
 430c8732-e4ef-4f31-a80f-76e5474c66cc | influence-legacy   | confidence_below_threshold  | 0.5882353186607361  | needs_human_review
```

## 7. Proof the HIGH-confidence fuzzy case DID spawn a real worker

```sql
select count(*), body->>'session_id', body->>'cost_usd', body->>'directory'
from controlplane.events
where kind='worker_dispatch_result' and body->>'project_id'='myi2-appp-service'
group by 2,3,4;
```
```
 count |              session_id              |       cost_usd       |           directory
-------+---------------------------------------+-----------------------+--------------------------------
     1 | cb1f6c81-9329-4e36-9bee-601b8133d5e6  | 0.020639400000000002 | /Users/celeste7/Documents/MYI2
```
Exactly **1** row — a real Claude session (`claude-haiku-4-5-20251001`, role `probe`,
`Read`-only), a real logged cost, spawned in the **correct** directory
(`/Users/celeste7/Documents/MYI2` — the same real directory the exact-match `myi2` row points
at, proving the fuzzy match correctly resolved the near-miss `project_id` to the right owner,
not a guessed one). `routing_decision` event for this item shows `match_type='fuzzy'`,
`confidence=0.9444444179534912`, `threshold=0.9`, `decision='route'` — a genuine fuzzy match
above threshold, not a disguised exact match (`match_type` came back `'fuzzy'` from the SQL
function itself, not asserted).

## 8. Final database state

`controlplane.events` — cumulative across G5 + F2, by kind:
```
          kind          | count
-------------------------+-------
 routing_decision        |     5
 unrouted_error          |     2
 worker_dispatch_result  |     3
```
(G5 contributed 3/1/2 respectively; F2 added exactly 2 `routing_decision` + 1 `unrouted_error`
+ 1 `worker_dispatch_result` — matches the 2 payloads sent.)

`controlplane.project_ownership` — 4 rows (3 from G5 + 1 new near-miss seed), full dump at
`02-forge/results/f2_ownership_final.txt`.

`controlplane.unrouted_errors` row for `influence-legacy` — full dump at
`02-forge/results/f2_unrouted_final.txt`.

`controlplane.events` `worker_dispatch_result` row for `myi2-appp-service` — full dump at
`02-forge/results/f2_worker_event_final.txt`.

## 9. Gate verdict

| Sub-condition | Result |
|---|---|
| `pg_trgm` confirmed absent, then enabled via `CREATE EXTENSION IF NOT EXISTS` | PASS |
| `controlplane.lookup_owner_fuzzy(text)` built — exact-first, trigram fallback, returns real score | PASS |
| Dispatcher wired: `routable = exact_match OR (fuzzy_match AND confidence >= threshold)` | PASS |
| New near-miss seed row (`myi2-app-service`), genuinely new pair, not the task's literal example | PASS |
| LOW case (`influence-legacy`, sim=0.5882, in the 0.5–0.7 band) correctly suppressed | PASS |
| LOW case: 0 `worker_dispatch_result` rows, 0 stream-json processes, real (non-NULL) confidence logged | PASS |
| HIGH case (`myi2-appp-service`, sim=0.9444, one-char typo) correctly routed | PASS |
| HIGH case: 1 real worker spawned, correct directory, real session id, real cost logged | PASS |
| Both cases exercise the previously-unreachable `confidence < threshold` branch with real numbers | PASS |

**F2: PASS.**

## 10. Containers / processes left running

```
central-mvp-redis   Up (unchanged, port 6380)    ← reused, not recreated
central-mvp-pg       Up (unchanged, port 5433)    ← reused, not recreated, schema now has 8 tables (7 from G5 + no new tables; pg_trgm added as an extension, not a table) + 1 new function
node ingest.mjs       STOPPED (killed after the run, confirmed via failed health check)
claude worker procs   NONE running (the one HIGH-case worker exited cleanly, exit_code=0)
```

## 11. Real cost

One real Claude spawn, `role: probe` (`claude-haiku-4-5-20251001`), 1 turn, `Read`-tool only,
read-only by construction:
- `myi2-appp-service` worker: **$0.0206394** (~$0.0206)

The LOW-confidence item spawned nothing and cost $0.

**Total F2 spend: $0.0206394.**
