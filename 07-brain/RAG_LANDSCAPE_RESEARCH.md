# Knowledge Substrate Research — Code + Document RAG for CENTRAL

Date: 2026-08-20 · Read-only research, nothing modified · Seat: CENTRAL

**Bottom line up front:** port JARVIS's own `runner.facts` + embedding-substrate pattern into
the `controlplane` schema, scoped by a new `project_id` column, once one live blocker is fixed
(pgvector is not actually installed on `central-mvp-pg` today — see §0). Nothing surveyed below
beats extending proven, already-read local prior art. No external tool or framework earns its
complexity at CENTRAL's current scale.

---

## §0. A live fact-check on the task's own premise

The task assumed *"CENTRAL's own Postgres (central-mvp-pg, port 5433) almost certainly already
has pgvector available … since the project's SQL migrations already used pg_trgm from the same
contrib family."* That assumption does not hold — verified live, not inferred:

```
$ docker inspect central-mvp-pg --format '{{.Config.Image}}'
postgres:15-alpine

$ docker exec central-mvp-pg psql -U postgres -c \
  "SELECT * FROM pg_available_extensions WHERE name='vector';"
 name | default_version | installed_version | comment
------+-----------------+--------------------+---------
(0 rows)

$ docker exec central-mvp-pg psql -U postgres -c "CREATE EXTENSION IF NOT EXISTS vector;"
ERROR:  extension "vector" is not available
DETAIL:  Could not open extension control file
  "/usr/local/share/postgresql/extension/vector.control": No such file or directory.
```

`pg_trgm` (used in `02-forge/sql/006_fuzzy_ownership.sql:13`) is bundled in the **standard
Postgres contrib set** that ships inside every stock `postgres` image. `pgvector` is **not**
contrib — it is a separate extension that must be compiled in or pulled from an image the
pgvector maintainers publish. The "same contrib family" reasoning was wrong; `pg_trgm`'s
presence says nothing about `vector`'s presence, and it isn't there.

This is not a reason to look elsewhere — it is a one-line fix, well-trodden and maintained:
swap the compose image from `postgres:15-alpine` to the official **`pgvector/pgvector:pg15`**
image (built and published by the pgvector project itself specifically for this), or add the
`postgresql-pgvector` Alpine community package if staying on a bare Alpine base. Either way
it's a Docker image change, not an architecture change — flagged here as the actual first step
of the recommendation in §4, not a reason to reconsider the plan.

---

## §1. Code-repo search/context for agents

CENTRAL's workers already do real code search today via plain Grep/Glob/Read against real
cloned directories resolved through `controlplane.project_ownership`
(`02-forge/sql/003_ownership.sql:12-25`) and its fuzzy fallback
(`02-forge/sql/006_fuzzy_ownership.sql:51-85`). That already works and cost zero new build. The
question researched here is narrow: what would a *semantic* layer add on top, and is it worth
the complexity given nothing in this project has needed it yet.

| Tool | What it actually is (2026) | Library you could embed, or hosted product? |
|---|---|---|
| **Aider repo-map** | Tree-sitter parses every source file into definitions/references; a PageRank graph over that ranks which symbols matter most for the current task; the ranked map is fit into a token budget (default 1k). **No embeddings at all.** | Genuinely embeddable. `repomap.py` in the Aider-AI/aider repo is plain Python, MIT-licensed, no server, no vector store — a few hundred lines you could vendor and adapt directly. Cheapest possible semantic-ish upgrade path if code-search ever outgrows grep. |
| **Continue.dev** | Open-source, but built as a VS Code / JetBrains **editor extension**. Codebase indexing runs inside that extension process: tree-sitter AST parsing + local embeddings via transformers.js, stored in LanceDB + SQLite under `~/.continue/index`. | Not a clean library import for a backend daemon. Adopting it means adopting its editor-coupled indexing service, not a function call — the wrong shape for CENTRAL's multi-agent control plane. |
| **Sourcegraph Cody (OSS core)** | Cody Free and Cody Pro were **discontinued July 2025**. As of 2026 Cody exists only as **Cody Enterprise, $59/user/month, annual contract** — individual users are pointed to a spun-off product (Amp) instead. | Not adoptable locally at all now — there is no open-source individual tier left to embed. |
| **Greptile** | SaaS-only code search/review product. No open-source release; the only self-host option is an enterprise AWS deployment, not a downloadable library. | Full hosted product, not adoptable for a local single-Mac-Studio control plane. |

**Verdict for §1:** none of these are a drop-in win over what already runs. Cody and Greptile
are disqualified outright (enterprise-only / SaaS-only, not open-source-adoptable in 2026).
Continue.dev is real open source but is shaped as an editor extension, not a library — adopting
it would mean running its whole indexing service for no query CENTRAL currently makes. Aider's
repo-map is the one genuinely reusable idea here (tree-sitter + PageRank, zero embeddings, MIT
license) — worth remembering as the cheap next step *if* a semantic code-search need actually
shows up, but nothing in CENTRAL has needed it yet, consistent with the G6 gate's rejection of
speculative external adoption earlier today. Do not build this now.

---

## §2. Document/knowledge RAG for non-code content

Real 2026 landscape, checked directly rather than assumed:

- **Dedicated vector DBs (Qdrant, Weaviate, Chroma, Milvus)** — all genuinely open source
  (Apache-2.0 / BSD-3), all self-hostable. But every one of them is a **separate service** you
  run, operate, back up, and secure independently of Postgres. Current benchmarking (2026)
  puts the practical sizing this way: Chroma wins for zero-friction prototyping under ~1M
  vectors (in-process, no Docker); Qdrant is "overkill for small projects" at low vector counts
  — its own filter queries were measured *slower* than Chroma's at 1,000 vectors, precisely
  because the tenant-filter/small-scale case is not what it's optimized for; pgvector is called
  out as "a reasonable production choice up to roughly 50 million vectors" and the explicit
  pick for a **sovereign, single-service production RAG pipeline under 1M vectors**.
- **pgvector-in-existing-Postgres** — CENTRAL already runs `central-mvp-pg` (once the image
  swap in §0 lands). No second service, no second backup story, no second credential to manage.
  At CENTRAL's actual scale (a handful of business-segment projects, each with a git repo plus
  pitch decks/marketing docs/meeting notes — thousands of rows, not millions), pgvector inside
  the Postgres that's already there is not a compromise; it's the sizing-appropriate choice
  according to the same 2026 sources that recommend the dedicated DBs for larger or
  higher-QPS workloads CENTRAL doesn't have.
- **Frameworks (LlamaIndex, LangChain)** — current 2026 guidance is explicit that "roll custom
  when you've outgrown frameworks" and that a hand-rolled embed→store→cosine-similarity loop is
  "about 200 lines of Python" giving complete control. Frameworks earn their weight at 100K+
  daily queries or when their abstractions start hiding real bottlenecks — neither condition
  exists at CENTRAL's current scale.
- **A minimal hand-rolled chunk+embed+cosine-similarity approach** — this is not a hypothetical
  fallback; it is **literally what JARVIS's `009_embedding_substrate.sql` already implements
  and what was already running in production**: one generic `embed_queue` table
  (`sql/009_embedding_substrate.sql:43-55`), one atomic multi-worker-safe claim RPC
  (`:82-116`, `FOR UPDATE SKIP LOCKED`), one `SECURITY DEFINER` trigger function
  (`enqueue_embed_row()`, `:125-144`) registered per table with an `INSERT`/`UPDATE`-with-`WHEN`
  trigger pair (thirteen worked examples at `:153-389`, including `runner.facts` itself at
  `:328-344`), plus HNSW indexes (`vector_cosine_ops`) on every embedded column. This is a
  hand-rolled substrate, proven live (`0.8.0`, HNSW-supported, verified 2026-05-31 per the file's
  own header at `:27`), doing exactly what a framework would give — with none of the framework.

**Verdict for §2:** a dedicated vector DB or a RAG framework would be solving a problem CENTRAL
does not have — neither the row-count scale nor the query-rate that would justify a second
running service or an abstraction layer over a 200-line loop that's already written and
already proven. pgvector inside the Postgres CENTRAL already runs is the correct-scale choice
by the current external sources' own sizing guidance, independent of the "don't reinvent"
discipline — the two arguments agree rather than one overriding the other.

---

## §3. Per-project scoping

CENTRAL already has the shape this needs: `controlplane.project_ownership`
(`02-forge/sql/003_ownership.sql:12-18`) maps a `project_id text primary key` to a real
`local_directory`, plus a fuzzy-match RPC (`lookup_owner_fuzzy`,
`02-forge/sql/006_fuzzy_ownership.sql:51-85`) for near-miss identifiers. That is the existing
per-project identity CENTRAL already resolves against — the embedding substrate should key off
the exact same `project_id`, not invent a second notion of tenancy.

Checked directly against 2026 pgvector guidance (including an open pgvector GitHub issue on
filtered-HNSW recall, #980) for the two real options:

1. **A `project_id` column + a `WHERE project_id = $1` clause + a per-project-filtered HNSW
   query** — the recommended pattern. Current pgvector docs are explicit: add a **plain
   B-tree index on the filter column**, keep the HNSW index on the vector column alone, and
   *do not* build a composite HNSW index containing `project_id` — pgvector walks the HNSW
   graph first and applies the filter after, so a highly selective filter (one project's rows
   out of many) can under-return unless `hnsw.iterative_scan` (added in pgvector 0.8, `relaxed`
   or `strict` mode) is enabled to keep walking until enough filtered matches are found. At
   CENTRAL's per-project row counts (low thousands, not millions) this tuning knob is a
   contingency, not a day-one requirement — a bare `WHERE project_id = $1 ORDER BY embedding
   <=> $2 LIMIT k` will already perform fine; `iterative_scan` is the documented lever to reach
   for if recall degrades as any one project's row count grows.
2. **Genuinely separate stores per project** — rejected. It would mean N Postgres schemas or N
   database instances doing identical DDL, N sets of triggers, N HNSW indexes to tune, and would
   defeat the one thing JARVIS's design already gives away for free: **one queue, one claim RPC,
   one worker pool serving every table** (`sql/009_embedding_substrate.sql:1-29` header —
   "any table gains embeddings via one trigger"). Splitting by project multiplies the exact
   operational surface that pattern was built to collapse, for a scale (a handful of
   business-segment projects on one Mac Studio) where a `WHERE` clause costs nothing.

**Verdict for §3:** `project_id text references controlplane.project_ownership(project_id)` on
both the facts table and any new documents table, a plain B-tree index on it, HNSW on the
embedding column alone, `hnsw.iterative_scan` as the documented escape hatch if any one
project's corpus grows large. This is the shape CENTRAL's schema already assumes everywhere
else (`items`, `pending_writes` scoping by `session_id` the same way) — not a new
multi-tenancy architecture, the same one already in use.

---

## §4. Concrete recommendation — decisive

**(a) Port JARVIS's exact facts+embedding substrate pattern into `controlplane`, scoped by
`project_id`, on the already-available (once fixed) pgvector extension. Do not adopt an
external tool or framework.**

Why this wins outright rather than narrowly:

- **The code-search half (§1) needs nothing new.** Grep/Glob/Read against
  `project_ownership.local_directory` already works at zero cost; every candidate external tool
  is either not open-source-adoptable in 2026 (Cody, Greptile) or the wrong shape to embed
  (Continue.dev's editor-coupled service). Building a semantic code layer now would be solving
  a problem this project has not encountered — explicitly the class of move G6 already rejected
  today.
- **The document half (§2) is not a gap — it's already-written code.** `009_embedding_substrate.sql`
  is a complete, proven, generic embed-anything substrate: one queue, one atomic claim RPC, one
  `SECURITY DEFINER` trigger function, HNSW indexes, already battle-tested in production (bge-small-en-v1.5,
  384-d, verified live 2026-05-31). `controlplane` already ported the sibling piece —
  `controlplane.facts` (`02-forge/sql/001_schema.sql:144-156`) is a near-verbatim copy of
  `runner.facts` (`JARVIS/jarvis-runner/sql/007_facts.sql:16-25`), missing only the embedding
  column, the HNSW index, and the enqueue trigger that `009` already defines for that exact
  table (`sql/009_embedding_substrate.sql:328-344`). Finishing that port is strictly smaller
  work than adopting any framework surveyed in §2, and current 2026 sizing guidance (§2)
  independently agrees pgvector-in-Postgres is the right-scale choice, not merely the
  path-of-least-resistance one.
- **The scoping half (§3) needs one column CENTRAL already has a home for** — `project_id`
  keying off `controlplane.project_ownership`, the identity model this project already
  standardized on for every other table.

### Concrete next migration (not yet written, scoped here for a follow-up)

A `02-forge/sql/007_knowledge_substrate.sql` should, in the order `EXTRACTION_MANIFEST.md`'s own
"extraction order" section already recommends (§ "Extraction order," item 2 → this is its
direct continuation):

1. Swap `central-mvp-pg`'s image from `postgres:15-alpine` to `pgvector/pgvector:pg15` (or add
   the `postgresql-pgvector` Alpine package) — the blocker found live in §0.
2. `CREATE EXTENSION vector;` (verified idempotent pattern already used in
   `009_embedding_substrate.sql:35`).
3. Add `project_id text references controlplane.project_ownership(project_id)`,
   `embedding vector(384)`, and an HNSW index to `controlplane.facts` — completing the port
   `001_schema.sql:144-156` left unfinished relative to `009_embedding_substrate.sql:328-344`.
4. Add a new `controlplane.documents` table (pitch decks, marketing docs, meeting notes) with
   the same `project_id` + `embedding vector(384)` + HNSW shape, source path, and a
   `body`/`chunk_text` column, reusing the *identical* `embed_queue` +
   `claim_embed_batch` + `enqueue_embed_row()` machinery from `009_embedding_substrate.sql:43-144`
   verbatim rather than re-derived — that machinery is schema-agnostic by design (`TG_TABLE_SCHEMA`
   / `TG_TABLE_NAME` read from trigger context at `:139-140`), so pointing it at a new
   `controlplane` table costs one more `ALTER TABLE` + two more `CREATE TRIGGER` statements, not
   new logic.
5. Explicitly do **not** port `002_grants.sql` (already flagged and rejected in
   `EXTRACTION_MANIFEST.md:84` and `002_roles.sql`'s least-privilege replacement) — the
   embedding substrate should sit behind the same `controlplane_ai_writer` / approver role split
   already established for the rest of the schema.

**If (b) were ever justified:** the one candidate worth naming, if CENTRAL's scale ever
genuinely outgrows this (multi-million-row corpora, high concurrent query rate, or a real need
for hybrid sparse+dense search pgvector doesn't do natively) would be **Qdrant** — Apache-2.0,
genuinely self-hostable, the dedicated DB 2026 sources consistently rank above Chroma/Weaviate
for production filter correctness once past pgvector's practical ceiling. Not justified today:
none of CENTRAL's business-segment projects are within an order of magnitude of the row counts
where that ceiling matters, and Qdrant adds an entire second service to operate for no query
CENTRAL currently makes.

---

## Evidence log

- `JARVIS/jarvis-runner/sql/007_facts.sql:16-39` — `runner.facts` table, indexes, grant.
- `JARVIS/jarvis-runner/sql/009_embedding_substrate.sql:1-29,35,43-144,153-174,328-344` —
  the universal embedding substrate: header/design intent, `CREATE EXTENSION vector`, queue +
  claim RPC + trigger function, worked per-table examples including `runner.facts` itself.
- `/Users/celeste7/Documents/CENTRAL/01-audit/EXTRACTION_MANIFEST.md` §B3 (lines 74-84) and
  "Extraction order" (lines 204-211) — the manifest that already scoped this exact port.
- `/Users/celeste7/Documents/CENTRAL/02-forge/sql/001_schema.sql:144-156` — `controlplane.facts`,
  the already-ported (embedding-less) half of this substrate.
- `/Users/celeste7/Documents/CENTRAL/02-forge/sql/003_ownership.sql:12-25` —
  `controlplane.project_ownership`, the identity model `project_id` scoping should key off.
- `/Users/celeste7/Documents/CENTRAL/02-forge/sql/006_fuzzy_ownership.sql:1-97` — pg_trgm fuzzy
  lookup; proof that `pg_trgm` (contrib) being present says nothing about `pgvector` (not
  contrib) being present — the false inference corrected in §0.
- Live verification, this session: `docker inspect central-mvp-pg` → image `postgres:15-alpine`;
  `pg_available_extensions` → no `vector` row; `CREATE EXTENSION vector` → fails, control file
  not found. `pg_trgm 1.6` confirmed installed.
- WebSearch, 2026-08-20: Aider repo-map (tree-sitter + PageRank, no embeddings, MIT);
  Continue.dev codebase indexing (LanceDB + SQLite, editor-extension-coupled); Sourcegraph Cody
  (Free/Pro discontinued July 2025, Enterprise-only $59/mo since); Greptile (SaaS-only, not
  open source); pgvector vs Qdrant/Weaviate/Chroma 2026 benchmarks (pgvector recommended
  sovereign choice under ~1M vectors, up to ~50M as a ceiling); pgvector filtered-HNSW pattern
  (plain B-tree filter column + `hnsw.iterative_scan`, never composite HNSW with the filter
  column, pgvector GH issue #980); LlamaIndex/LangChain vs hand-rolled (custom recommended
  until 100K+ daily queries; ~200-line hand-rolled loop cited as sufficient); official
  `pgvector/pgvector:pg15` Docker image confirmed to exist for the image-swap fix in §0.
