# paperclipai/paperclip — Evaluation Against CENTRAL's Adoption Gate

Investigated: 2026-08-20. Repo cloned read-only into scratchpad
(`/private/tmp/claude-501/.../scratchpad/paperclip`, shallow depth-100 clone off
`master` @ `cbe6395`), never into the CENTRAL project tree. Verified against
real source, not the README's marketing copy.

## 0. Bottom line

**Real product, genuinely relevant to CENTRAL's runtime/orchestration side —
not relevant to the knowledge-substrate ("brain") gap.** Paperclip is a real,
actively-maintained multi-agent control plane that spawns actual Claude
Code / Codex / Cursor / Hermes CLI subprocesses headlessly, parses real
`stream-json` output, and has real per-run MCP wiring — all three legs of
CENTRAL's standing gate pass on inspected code, with exact citations below.
But it has **no document/knowledge-indexing capability at all** — no
embeddings, no vector DB, no full-text search, nothing that ingests a repo or
docs into something queryable. Its "documents" are Notion-style wiki pages
attached to issues/pipelines, indexed only by a `pg_trgm` GIN trigram index
for fuzzy title/body search-as-you-type — not a "brain." It is worth studying
as a second real reference implementation of the headless-agent-spawn +
budget/governance pattern CENTRAL already has proven; it is not a candidate
for the knowledge-substrate gap.

---

## 1. What it actually does

**Verdict: real orchestration of actual running agent processes, not a
task-tracker with agent-shaped labels.**

The README states the positioning directly: *"If OpenClaw is an employee,
Paperclip is the company."* (`cli/README.md`). That framing is backed by real
code, not just copy. Paperclip is a Node.js/TypeScript server + React UI
(monorepo: `server/`, `ui/`, `cli/`, `packages/`) that:

- Spawns real CLI subprocesses for each configured "agent" — Claude Code,
  Codex, Cursor, Gemini, Grok, OpenCode, Hermes Agent, a generic Bash
  adapter, an HTTP adapter — via a common `AdapterExecutionContext` /
  `execute()` contract (`packages/adapter-utils/src/types.ts:171`,
  `packages/adapters/*/src/server/execute.ts`).
- Runs those processes on a schedule ("heartbeat"), tracks token/cost usage
  per agent and per company with hard-stop budget enforcement, and persists
  session state across heartbeats via `--resume` (see
  `packages/adapters/claude-local/src/server/execute.ts:723-791`).
- Has an org chart (roles, reporting lines), a governance/approval workflow
  (`server/src/services/decisions.ts`, migration
  `packages/db/src/migrations/0197_decisions_v1.sql`), and a
  "pipelines"/"cases" system for multi-step agent work
  (`server/src/services/pipelines.ts`, ~4,300+ lines).
- Ships a genuine "no-remote-git contract" enforced by a CI static check
  (`scripts/check-no-git-push.mjs`, described in
  `packages/adapters/AUTHORING.md`) governing how agent-driven workspaces
  persist code across runs without ever depending on a git remote — this is
  real infrastructure-engineering discipline, not a stub.

This is the same *kind* of system CENTRAL is building (a control plane that
spawns and governs real agent CLI processes), just with a much heavier
product surface (org chart, budgets, board/approval workflow, mobile UI,
multi-tenant "companies"). It is not a Linear/Asana clone with an "agent"
assignee type — the assignee genuinely is a live subprocess Paperclip starts,
feeds a rendered prompt to via stdin, and parses structured output from.

## 2. Document/knowledge-indexing capability

**Verdict: absent.** This is the exact gap CENTRAL is researching, and
Paperclip does not fill it.

Evidence of absence, from exhaustive greps over the full non-`node_modules`
tree (not a feature-list read):

- No hits anywhere in the codebase for `embedding`, `pgvector`, `tsvector`,
  `to_tsvector`, `pinecone` (as a library call), `weaviate`, `qdrant`,
  `chromadb`, `text-embedding`, `cosine similarity`, or `semantic search`.
  The single `pinecone` string hit
  (`packages/shared/src/app-definitions.ingestion-report.json:1560`) is a
  catalog entry offering Pinecone as one of many *customer-connectable*
  third-party MCP-remote tools (`"transport": "mcp_remote"`) — exactly the
  same shape as their Google Sheets or Slack catalog entries. It is not
  Paperclip's own storage; nothing in the repo calls it.
- The only thing called "documents" in the schema
  (`packages/db/src/migrations/0028_harsh_goliath.sql`) is a
  Notion/Confluence-style wiki page attached to an issue: `documents`,
  `document_revisions`, `issue_documents` tables holding
  agent- or user-authored markdown (`latest_body text`), with revision
  history and annotation threads
  (`packages/db/src/migrations/0091_old_swarm.sql`). This is collaborative
  authored content *inside* Paperclip, not an index over an external repo or
  document corpus.
- The only search index on that table is a `pg_trgm` GIN trigram index for
  typeahead fuzzy matching —
  `packages/db/src/migrations/0079_company_search_document_indexes.sql:1-2`:
  `CREATE INDEX ... ON "documents" USING gin ("title" gin_trgm_ops);` and the
  same for `latest_body`. Trigram similarity, not full-text (`tsvector`) and
  nowhere near semantic/embedding retrieval.
- Grepping for the word "knowledge" across `*.ts`/`*.md` returns only false
  positives on "acknowledge/acknowledged" (`server/src/services/pipelines.ts`,
  `plugin-worker-manager.ts`) — the concept "knowledge base" does not exist
  in the product.
- The MCP server Paperclip exposes (`packages/mcp-server/README.md`, tool
  list at lines ~30-70) has `paperclipListDocuments` / `paperclipGetDocument`
  tools — but these are thin CRUD wrappers over the wiki-page table above
  ("This package is a thin MCP wrapper over the existing Paperclip REST API.
  It does not talk to the database directly and it does not reimplement
  business logic." — `packages/mcp-server/README.md:5-6`), not a retrieval
  system.

The repo checkout each agent works in (a git worktree) is real, and the
agent CLIs themselves (Claude Code, Codex, etc.) have their own file
search/grep tools — but that capability belongs to the underlying agent, not
to anything Paperclip built. Paperclip does not ingest a project's repo or
docs into any queryable store of its own.

## 3. CENTRAL's standing gate, applied explicitly

### 3a. stream-json-style structured streaming output — PASS, verified

`packages/adapters/claude-local/src/server/execute.ts:838` constructs the
actual Claude Code CLI invocation:

```ts
const args = ["--print", "--output-format", "stream-json", "--verbose"];
```

with `--resume <sessionId>`, `--model`, `--effort`, `--max-turns`,
`--mcp-config <path> --strict-mcp-config`, `--append-system-prompt-file`, and
`--add-dir` appended conditionally (lines 839-865). This is genuinely the
same headless invocation shape CENTRAL's own Claude Code spawn primitive
uses.

The output is not just captured, it is really parsed, line-by-line JSON, in
`packages/adapters/claude-local/src/server/parse.ts` — `parseClaudeStreamJson`
(function starts ~line 50) iterates each `stdout` line, `JSON.parse`s it, and
switches on `event.type`:
- `"system"` / `subtype: "init"` → captures `session_id`, `model`
- `"assistant"` → walks `message.content[]` blocks, collects `type: "text"`
  segments
- `"result"` → captures the terminal result object (cost, usage, `is_error`,
  `subtype`, `session_id`)

This is a correct, schema-aware implementation of Claude Code's real
`stream-json` event shape (`system/init`, `assistant`, `result`), not a
guess or a passthrough. The Codex, Cursor, Gemini, Hermes adapters have
matching per-provider `parse.ts` files
(`packages/adapters/{codex,cursor-local,gemini-local,hermes}/src/server/*`)
implementing each CLI's own structured-output format.

### 3b. Real MCP server/client support — PASS, verified

**Client side (agents connect out to MCP servers Paperclip wires up):**
`writePaperclipClaudeMcpConfig()` (`packages/adapters/claude-local/src/server/claude-config.ts`,
called from `execute.ts:522-526`) materializes a real Claude MCP config file
from `ctx.runtimeMcp.getServers()`, then the invocation passes
`--mcp-config <path> --strict-mcp-config` (`execute.ts:861`) — `--strict-mcp-config`
means only Paperclip-provisioned servers are trusted, no ambient config
leakage. `AdapterExecutionContext.runtimeMcp` (`packages/adapter-utils/src/types.ts`)
is a first-class field on every adapter's context, not Claude-specific.

**Server side (Paperclip itself is an MCP server):**
`packages/mcp-server/` ships an installable `@paperclipai/mcp-server` package
(`bin: paperclip-mcp-server`, `packages/mcp-server/package.json`) exposing
~20 read tools (`paperclipListIssues`, `paperclipGetHeartbeatContext`,
`paperclipListDocuments`, ...) and ~16 write tools (`paperclipCreateIssue`,
`paperclipCheckoutIssue`, `paperclipUpsertIssueDocument`,
`paperclipApprovalDecision`, ...) plus an escape-hatch `paperclipApiRequest`
tool (full list: `packages/mcp-server/README.md`). This is a real,
standalone, `npx`-installable MCP server, stdio-based
(`packages/mcp-server/src/stdio.ts`), not a stub.

There is also a live app catalog offering dozens of third-party services as
customer-connectable MCP-remote tools (Pinecone, Google Sheets, Slack, etc.
— `packages/shared/src/app-definitions.ingestion-report.json`), plus
example first-party MCP servers (`packages/google-sheets-mcp-server`,
`packages/kv-demo-mcp-server`) that ship in the same monorepo as worked
examples of the pattern.

### 3c. Genuine headless/non-interactive execution — PASS, verified, at two levels

1. **The agent CLIs Paperclip drives run headlessly by construction** — the
   `--print` flag (`execute.ts:838`) is Claude Code's own non-interactive
   flag; stdin carries the rendered prompt (`runAdapterExecutionTargetProcess(...,
   { stdin: prompt, ... })`, `execute.ts:920-935`); there is no TTY, no
   attached terminal, no UI dependency for the agent process itself to run.
2. **Paperclip's own CLI (`cli/`) is a real scriptable client, not just an
   installer.** `cli/src/index.ts` registers dozens of non-interactive
   subcommands via `commander`: `registerIssueCommands`, `registerAgentCommands`,
   `registerProjectCommands`, `registerRunCommands`, `registerRoutineCommands`,
   `registerPipelineCommands`, `registerWorkspaceCommands`,
   `registerAdapterCommands`, `heartbeatRun`, `dbBackupCommand`, etc.
   (`cli/src/index.ts:1-49`). Company/agent/issue/run state can genuinely be
   driven end-to-end from a terminal or script without opening the web UI —
   the web dashboard is a view onto the same state, not the only way to
   operate the system.

**All three gate legs pass on real, read code — no README-trusting
required.**

## 4. NousResearch/hermes-paperclip-adapter — real integration surface, now folded into core

Checked directly (`gh repo view`, `gh api .../contributors`,
`gh api .../commits`):

- Created 2026-03-11, last pushed 2026-04-04 — **stale for ~4.5 months as a
  standalone repo**, 1,820 stars, 373 forks, only 3 contributors: `teknium1`
  and `Nour Eddine Hamaidi` (both Nous Research), plus `Stefan Vandermeulen`.
  10 commits visible in the sampled history, real fixes (auth header
  injection, config resolution, timeout defaults) — small but genuine, not a
  placeholder.
- It was not abandoned so much as **absorbed**: `paperclipai/paperclip`'s
  own `packages/adapters/hermes/README.md` says explicitly *"This package
  owns both built-in Hermes adapter types ... during package consolidation"*
  — i.e., Nous Research's standalone adapter was merged into the core
  Paperclip monorepo as the built-in `hermes_local` / `hermes_gateway`
  adapters, complete with its own execute.ts, parse.ts, skills bridge
  (`packages/adapters/hermes/skills/paperclip-task-bridge/`), and tests.

This is a real answer to "is the adapter protocol a genuine third-party
integration surface": yes — an external company (Nous Research) built and
shipped a conforming adapter against Paperclip's `AdapterExecutionContext`
contract, it worked well enough to be pulled into the core product, and the
same contract is documented for authors generally
(`docs/adapters/creating-an-adapter.md`, referenced from
`packages/adapters/AUTHORING.md`). It is not a one-off toy example — but note
it is currently a two-party case (Nous Research + Paperclip Labs), not yet
evidence of a broad third-party ecosystem.

"Managed employee" is not deep metaphysics — structurally it just means: one
row in an `agents` table, bound to one `adapterType` (a key into the adapter
registry above), executed on a heartbeat, budget-capped, org-chart-placed.

## 5. Maintenance reality — real, not scaffolding

- Repo created 2026-03-02, last push 2026-08-20 (this task's own investigation
  window) — ~5.5 months old.
- **3,748 commits total** on `master` (`gh api repos/.../commits` Link header,
  `rel="last"` → page 3748 at `per_page=1`).
- **190 contributors** (`gh api repos/.../contributors`). Top contributor
  `cryppadotta` (2,448 commits) verified as a real person — GitHub account
  created 2017, bio *"CEO Paperclip Labs"* (`gh api users/cryppadotta`), not
  a bot or sockpuppet. Next tier: `devinfoley` (369), `nickyleach` (165),
  `dependabot[bot]` (126), `stubbi` (33), `scotttong` (31), and a long real
  tail down to single-digit contributors — consistent with a funded team
  plus community PRs, not a single-author project wearing a crowd's clothing.
- **1,790 merged PRs total; 118 merged in the 7 days before this check**
  (`gh api search/issues?q=repo:paperclipai/paperclip+type:pr+is:merged...`)
  — roughly 17 merged PRs/day, sustained. That is a very high, very real
  velocity, not a repo coasting on stars.
- Recent commit subjects read as genuine engineering, not cosmetic churn:
  `fix(runtime): assert order-independent port invariants for concurrent
  siblings`, `feat(sandbox): add a duplex transport for Daytona behind a
  default-off kill switch`, `fix(server): make blockers-resolved wake dedup
  level-triggered` (sampled from `gh api repos/.../commits`, 2026-08-19/20).
- 78,971 stars / 14,467 forks against only 5.5 months of age and an MIT
  license is a large ratio, but the commit/contributor/PR-velocity evidence
  above is independent of stars and confirms real engineering effort behind
  it — this is not judged on star count, per the standing gate.
- Working code confirmed behind every README claim actually checked in this
  investigation (stream-json, MCP config, adapter execution, budget/session
  handling, no-git-push CI enforcement) — no case found in this pass where
  the README claimed something the code didn't back up. The one area where
  the README oversells relative to code is the "knowledge" implication of a
  document system — the docs feature is real but is wiki pages, not
  indexing.

## 6. Relevance to CENTRAL, decisively

- **Not relevant to the knowledge-substrate ("brain") gap.** Nothing to
  adopt or port here — no embeddings, no vector store, no full-text index
  over a project's repo/docs. The gap CENTRAL is researching remains
  unaddressed by this repo.
- **Relevant as a second real reference implementation of the
  headless-agent-orchestration pattern CENTRAL already has proven.** Worth a
  closer read specifically for: (a) the `AdapterExecutionContext` contract
  shape as a possible model for CENTRAL's own multi-runtime adapter
  boundary (it already supports Claude Code and Antigravity's `agy` as two
  runtimes — Paperclip's contract generalizes to N runtimes cleanly); (b)
  the budget/cost hard-stop enforcement pattern; (c) the "no-remote-git
  contract" + CI-enforced invariant pattern
  (`scripts/check-no-git-push.mjs`) as a model for enforcing CENTRAL's own
  RBAC/scope invariants in CI rather than only at runtime; (d) the
  `docs/specs/external-task-protocol.md` provider-agnostic task-sync spec,
  if CENTRAL ever needs to sync `controlplane.events`/`pending_writes`
  against an external tracker like Linear.
- Founder's original question — "relevant to the brain gap, or to anything
  else CENTRAL is building" — answer: **the second**, specifically the
  runtime/orchestration side, not the knowledge side.

---

### Files/paths cited (all inside the scratch clone unless noted)

- `packages/adapters/claude-local/src/server/execute.ts` (stream-json args:
  line 838; MCP config wiring: lines 513-526, 861; prompt via stdin:
  920-935)
- `packages/adapters/claude-local/src/server/parse.ts` (`parseClaudeStreamJson`)
- `packages/adapter-utils/src/types.ts` (`AdapterExecutionContext`, line 171)
- `packages/adapters/AUTHORING.md` (no-remote-git contract)
- `packages/mcp-server/README.md` (tool surface list)
- `packages/db/src/migrations/0028_harsh_goliath.sql` (`documents` schema)
- `packages/db/src/migrations/0079_company_search_document_indexes.sql`
  (trigram index, not FTS/embeddings)
- `packages/shared/src/app-definitions.ingestion-report.json:1560` (Pinecone
  catalog entry, not internal usage)
- `cli/src/index.ts` (CLI command registry)
- `cli/README.md` (positioning quote)
- `docs/specs/external-task-protocol.md`
- `packages/adapters/hermes/README.md` (Nous Research adapter consolidation)
- GitHub API: `repos/paperclipai/paperclip` (stars/forks/pushedAt),
  `.../contributors`, `.../commits`, `search/issues?...is:merged`;
  `repos/NousResearch/hermes-paperclip-adapter` (metadata, contributors,
  commits); `users/cryppadotta`.
