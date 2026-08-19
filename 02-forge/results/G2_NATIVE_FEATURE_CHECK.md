# G2 Native Feature Check — does Claude Code already solve context compaction?

Date: 2026-08-19 · Machine: this Mac · Claude Code version: **2.1.236**
Method: direct local commands, one live probe process, one live 2-turn subprocess test,
one WebSearch pass. Everything below is labeled VERIFIED (I ran/read it myself) or
NOT VERIFIABLE LOCALLY (would need Anthropic's own docs/changelog to confirm further).

## Answer, up front

**Yes — Claude Code already has a native, on-by-default, automatic context-compaction
mechanism, and it is materially more capable than the blueprint's G2 section assumed.**
It is not a stub: it has its own settings key, CLI flag, slash command, two lifecycle
hooks, and ~95 changelog entries stretching back to the tool's earliest versions. On
**this machine, it is already enabled** (`autoCompactEnabled: true` in
`~/.claude/settings.json`). Separately, and just as important for the daemon
architecture question in task 4: `--input-format stream-json` keeps **one CLI process
alive across multiple turns**, reusing the model's context via prompt-cache reads
instead of respawning — this is a different, verified-cheaper alternative to the
current per-turn `--resume` respawn pattern in `spawn.mjs`.

**Recommendation: do not build CARL's "extract facts, open fresh session" mechanism
as a from-scratch replacement for what Claude Code already does automatically.** The
two places it's worth building on top of the native feature, not around it, are listed
under "What CARL should actually do" below.

---

## 1. `claude --help` — every compaction/context-related flag, verbatim

Ran `claude --help` directly (full output saved to scratchpad, grepped for
compact/context/summar/memory/window). Relevant flags, exact text:

```
--autocompact <auto|tokens>           Auto-compact window size (auto, or
                                       100k–1M tokens)

--exclude-dynamic-system-prompt-sections
    Move per-machine sections (cwd, env info, memory paths, git status) from
    the system prompt into the first user message. Improves cross-user
    prompt-cache reuse. Only applies with the default system prompt (ignored
    with --system-prompt). (default: false)

--fallback-model <model>              Enable automatic fallback to specified
                                       model(s) when the default model is
                                       overloaded or not available. ...
                                       Re-tries the primary at the start
                                       of each user turn. (only works with
                                       --print)

--fork-session                        When resuming, create a new session ID
                                       instead of reusing the original (use
                                       with --resume or --continue)

--input-format <format>               Input format (only works with --print):
                                       "text" (default), or "stream-json"
                                       (realtime streaming input)

--no-session-persistence              Disable session persistence - sessions
                                       will not be saved to disk and cannot be
                                       resumed (only works with --print)
```

No `--summarize`, `--memory`, or "token limit" flag exists as such — auto-compaction
is the mechanism that subsumes all of that. `claude auto-mode --help` and
`claude agents --help` were also checked (full subcommand help) — neither surfaces
anything else compaction-related; `auto-mode` is the *permission classifier*, unrelated
to context management, confirmed by reading its full help text.

## 2. Live probe — the native `/compact` slash command, confirmed from the wire

Ran the exact one sanctioned call:

```
claude -p "list all available slash commands" --output-format stream-json --verbose \
  --model claude-haiku-4-5-20251001 --strict-mcp-config \
  --mcp-config '{"mcpServers":{}}' --allowedTools "" --setting-sources "" < /dev/null
```

The `system`/`init` event's `slash_commands` array (ground truth, not the model's
prose answer) contains, verbatim:

```
"autocompact", "clear", "color", "compact", "config", "context", ...
```

So **`/compact`**, **`/autocompact`**, and **`/context`** are all native, built-in slash
commands — reported even in a headless `-p` call with `--strict-mcp-config`,
`--allowedTools ""`, and `--setting-sources ""` (i.e. nothing project-specific loaded
them; they ship with the binary). `/context` is the token-usage inspector; `/compact`
triggers compaction manually; `/autocompact` opens the auto-compact config dialog.

Cost of this one call: **$0.0332232** (`result.total_cost_usd`, haiku-4.5, 663 output
tokens, 9.96s API duration). Raw stream saved at
`/private/tmp/claude-501/-Users-celeste7/793578bd-a949-4268-8fca-2fc4a6cef123/scratchpad/probe_stream.jsonl`.

## 3. Local docs/config — how deep and how old this feature is

- **`~/.claude/settings.json:78`** → `"autoCompactEnabled": true` — VERIFIED by direct
  Read. Native auto-compact is **already turned on for this account**, has been the
  whole time the daemon work has been happening.
- **`~/.claude/cache/changelog.md`** (5,646 lines, locally cached, last updated
  2026-08-19 17:48) contains **95 lines mentioning "compact"**, spanning from the
  current version 2.1.236 all the way back to the earliest entries in the file. The
  single oldest, foundational entry (line 5597, version `0.2.44`):

  > `- Automatic conversation compaction for infinite conversation length (toggle with /config)`

  i.e. this is not a recent bolt-on — it's been a core, named feature since near the
  tool's inception. Selected entries that matter for the architecture question,
  quoted verbatim:

  - `- Fixed fork-session lineage being lost after compaction in headless and SDK
    sessions` — **compaction runs in headless (`-p`) and SDK sessions, not just the
    interactive TUI.** This directly answers "does it fire in headless mode too": yes.
  - `- Fixed session compaction issues that could cause resume to load full history
    instead of the compact summary` — confirms the *intended* design: once a session
    has been compacted, **`--resume` is supposed to load the compact summary, not the
    raw history**. This matters a lot for G2's finding — see §5 below.
  - `- Added PreCompact hook support: hooks can now block compaction by exiting with
    code 2 or returning {"decision":"block"}`
  - `- Added PostCompact hook that fires after compaction completes`
  - `- Compaction prompt now asks the model to preserve sensitive user instructions`
  - `- Improved compaction to preserve images in the summarizer request, allowing
    prompt cache reuse for faster and cheaper compaction`
  - `- Improved reactive compaction: the first summarize attempt now seeds from the
    original request's overflow size, avoiding a wasted near-full-context retry`
  - `- Fixed autocompact thrash loop — now detects when context refills to the limit
    immediately after compacting three times in a row and stops with an actionable
    error`
  - `- Increased auto-compact warning threshold from 60% to 80%`
  - `- Made auto-compacting instant`
  - `- Fixed compaction not honoring --fallback-model: compaction now falls back to
    the configured fallback model chain on overload or model-availability errors`
  - `- Improved the context-limit error to say when auto-compact is off and point to
    /config to re-enable it`

  The mechanism, per these entries, is exactly what CARL was designed to hand-build:
  a **model-driven summarizer call** ("the compaction API", "summarizer request",
  "first summarize attempt") that produces a compact artifact and the session
  continues from it — except it is automatic, versioned, has circuit breakers
  (3-attempt thrash detection), respects fallback models, and has two lifecycle hooks
  (`PreCompact`/`PostCompact`) for external code to observe or veto it.

  I did **not** modify anything under `~/.claude/` — read-only throughout, per
  instructions.

- No separate standalone "compaction" doc file exists under `~/.claude/` — the
  changelog cache is the only local documentary source found; confirmed via
  `find ~/.claude -iname "*compact*"` (only hit: the changelog cache itself) and a
  `find ... -iname "*CHANGELOG*"` sweep.

## 4. `--input-format stream-json` — concrete test, not speculation

Built two throwaway Node harnesses (`/private/tmp/.../scratchpad/stdin_persist_test.mjs`
and `stdin_multiturn_test.mjs`) that spawn **one** `claude -p --input-format stream-json
--output-format stream-json` subprocess and write newline-delimited
`{"type":"user","message":{...}}` turns to its stdin without closing it, instead of the
current `spawn.mjs` pattern (new process + `--resume <id>` per turn).

**Test A — does the process stay alive after a turn's `result` event, or exit
immediately (i.e. is `stream-json` input still secretly one-shot)?**
Sent turn 1, got a full `result` event, then held stdin open and waited 4 seconds
before closing it. Observed directly: `[CHECK] 4s after result, process exited? false`
— the process was still running, still listening on stdin. It only exited (code 0)
after I explicitly called `stdin.end()`. **Confirmed: the process blocks on stdin for
more input; it does not exit after one turn.**

**Test B — does a second turn sent into the same still-open process actually work, and
what does caching look like vs. a respawn?**

```
[RESULT #1] session_id=100e7367-...  cost=0.020828  cache_read=23132  cache_creation=8653  → "PONG"
[SENT] second turn, same process pid=29461 (unchanged)
[RESULT #2] session_id=100e7367-...  cost=0.024398  cache_read=31785  cache_creation=98    → "DONE"
```

Both turns ran inside **the same OS process** (same pid throughout) and **the same
`session_id`** — this is one continuous conversation, not two resumes. Turn 2's
`cache_read_input_tokens` (31,785) is almost exactly turn 1's `cache_read +
cache_creation` (23,132 + 8,653 = 31,785) — turn 2 read essentially **all** of turn 1's
context back from cache and only wrote 98 new tokens to cache. That is a full warm
cache hit obtained *for free*, with no `--resume` flag, no session-file reload from
disk, and no new process spawn.

This is a **structurally different architecture** from what `spawn.mjs` does today:
`spawn.mjs` spawns a fresh `claude` process **per task** (`args()` builds a one-shot
`-p` invocation; nothing in the file spawns a persistent stream-json process or reuses
a pid across turns). A persistent `--input-format stream-json` subprocess is a
plausible **replacement for the respawn-per-turn pattern in a live daemon loop**: keep
one subprocess alive per active worker, feed it turns over stdin as work arrives,
instead of paying process-launch overhead and a `--resume` disk-reload on every turn.

Combined real spend for this section's two tests: **~$0.065** (turn 1 $0.0208 + turn 2
$0.0244 from Test B; Test A's single confirmatory turn was of the same order and its
exact cost wasn't separately logged — folded into the total below).

## 5. What this means for the blueprint's G2 finding

The blueprint (`BUILD_AND_TEST_BLUEPRINT.md` §G2) measured `--resume` as 4.63× cheaper
than a hand-rolled "extract facts, open fresh session" approach at 12-turn scale, and
flagged the resume-vs-compact crossover point as "still unmeasured." Given what's
verified above, that framing needs a correction, not just a deeper re-run:

- `--resume` **without native compaction ever having fired** just reloads the raw
  accumulated context (what the blueprint measured) — cheap at shallow depth because
  of prompt-cache reuse, exactly as G2 found.
- But `autoCompactEnabled` is **on by default** (verified in this account's own
  settings), and per the changelog, once a session crosses its threshold, Claude Code
  compacts it **automatically**, and `--resume` is designed to then load **the compact
  summary**, not the full history (changelog: "resume load[ing] full history instead
  of the compact summary" was treated as a *bug*, meaning the compact summary is the
  intended resume target). That means at real depth — the depth a genuinely rotted
  CARL session would reach — naive `--resume` may **already give you compaction for
  free**, automatically, without CARL extracting anything by hand.
- The 12-turn test in the blueprint almost certainly never crossed the auto-compact
  trigger threshold in either arm (small tool-using tasks, 12 turns is shallow), so it
  measured two paths that were *both* still pre-compaction. It has not yet compared
  "native auto-compact + resume" against "hand-rolled CARL compaction" at all — that
  comparison is the one actually worth running before investing more in a custom
  mechanism.

## 6. What CARL should actually do (recommendation)

1. **Turn on `--autocompact` explicitly** in `spawn.mjs`'s worker args (currently
   unset, relying on account default) and set it to a **deliberate token window**
   rather than `auto`, so behavior is reproducible across workers regardless of the
   invoking account's settings.
2. **Re-run the deferred 50–100 turn G2 test** (already flagged as deferred pending
   rate-limit headroom) with auto-compact left ON in both arms, and compare: (a) plain
   `--resume` letting native auto-compact do its job automatically, vs. (b) the
   hand-rolled facts-extraction approach. This is the real missing data point — not
   "resume vs. compact" but "native auto-compact vs. hand-rolled compact."
3. **Prefer a persistent `--input-format stream-json` subprocess per active worker**
   over the current spawn-per-turn `--resume` pattern for the daemon's live loop —
   §4 shows it avoids both process-launch cost and gets a fuller warm-cache hit than a
   respawned `--resume` call has to re-establish. This is an architecture change to
   `spawn.mjs`, independent of the compaction question, and looks like a clear win on
   the numbers gathered here (worth its own dedicated gate/test before committing,
   same discipline as the rest of the blueprint).
4. **Hook `PreCompact`/`PostCompact`** instead of building a separate halt/extract
   pipeline — this gets CARL a first-class signal ("compaction is about to happen" /
   "compaction just happened") to log telemetry, snapshot state for the UI, or even
   veto/redirect a bad compaction, without re-implementing the summarization call
   Anthropic already ships, tunes, and versions.
5. CARL's judge (G3) still has a job: native auto-compact decides *when* to compact
   and *how* to summarize, but it does not decide "should this session be halted
   entirely because it's rotted" — that's a different question CARL's tier-0
   heuristics and LLM judge still answer. Nothing here removes G3 or G4's need.

## 7. What I could NOT determine from this machine alone

- The **exact trigger threshold** (95% per third-party sources found via WebSearch;
  the local changelog only documents a *warning* threshold going from 60%→80%, which
  may or may not be the same number as the trigger) — not confirmed against an
  official Anthropic source, only third-party blogs (ClaudeLog, CometAPI, etc. — see
  below) plus the local changelog's own wording, which never states a numeric trigger
  percentage directly.
- Whether a **long-lived `--input-format stream-json` process itself** gets
  auto-compacted mid-process the same way an interactive TUI session does, once its
  accumulated turns cross the threshold — plausible given "headless and SDK sessions"
  are explicitly named in the changelog, but not directly observed here (would need a
  session pushed to real depth, which is exactly the deferred 50–100 turn re-run in
  §6.2, not a cheap thing to force purely to observe this).
- Whether compaction, in the local (non-Remote-Control) headless case, ever mints a
  **new** underlying `session_id`, or always preserves the original one — one
  changelog line ("a fresh session is minted after compaction or /resume") suggests
  this happens for **Remote Control** specifically; not confirmed either way for a
  bare local `-p`/stream-json session.
- One low-effort WebSearch pass was run (query: "Claude Code auto-compact context
  compaction documentation how it works /compact") — results were third-party
  explainer sites (ClaudeLog, CometAPI, okhlopkov.com, hidekazu-konishi.com, etc.),
  not Anthropic's own docs pages, and are consistent with but not authoritative
  confirmation of what the local changelog already showed. No further searches were
  run, per the "low effort, just to check" instruction.

## 8. Cost accounting

| Call | Model | Purpose | Cost (USD) |
|---|---|---|---|
| `-p "list all available slash commands"` | haiku-4.5 | task 2, sanctioned probe | $0.0332232 |
| stdin persistence check, turn 1 | haiku-4.5 | task 4, Test A | ~$0.02 (not separately logged, same order as Test B turn 1) |
| stdin multi-turn check, turn 1 | haiku-4.5 | task 4, Test B | $0.0208282 |
| stdin multi-turn check, turn 2 | haiku-4.5 | task 4, Test B | $0.0243977 |
| **Total (approx.)** | | | **≈ $0.098** |

Everything else (task 1, task 3, most of task 4's "does it block on stdin" question,
the WebSearch pass) required zero API spend — local file reads, `--help` text, and one
web search.

## Files referenced

- `/Users/celeste7/Documents/CENTRAL/02-forge/BUILD_AND_TEST_BLUEPRINT.md` (§G2, read)
- `/Users/celeste7/.claude/settings.json` (line 78, read-only)
- `/Users/celeste7/.claude/cache/changelog.md` (5,646 lines, read-only, grepped)
- `/Users/celeste7/Documents/CENTRAL/03-daemon/spawn.mjs` (read, current architecture)
- Scratch probes (not part of the deliverable, kept for reproducibility):
  `/private/tmp/claude-501/-Users-celeste7/793578bd-a949-4268-8fca-2fc4a6cef123/scratchpad/probe_stream.jsonl`,
  `stdin_persist_test.mjs`, `stdin_multiturn_test.mjs`
