# Second/third runtime — Gemini CLI / Antigravity

Status as of 2026-08-20. Full detail in each `GX*_RESULTS.md` and
`ANTIGRAVITY_WORKER_RESULTS.md`.

## The short version

- **Plain `gemini` CLI is dead on this account.** Google deprecated the free
  "Code Assist for individuals" tier this client used. Confirmed on installed
  0.55.1 and freshly-fetched 0.56.0 — same error, not a version bug. Needs a
  paid `GEMINI_API_KEY` or Vertex AI billing to ever work. **Not required** —
  see below.
- **`agy` (Antigravity's headless CLI) works right now, no API key needed.**
  Confirmed with a real live call. This is the actual second-runtime primitive
  — `gemini-worker.mjs` targets the broken CLI and is kept only as a reference
  for its correctly-reverse-engineered stream-json schema; `antigravity-worker.mjs`
  is the real, working, tested one.
- **`agy` has no built-in per-tool RBAC of any kind.** Checked every avenue.
  The only real enforcement is a `.agents/hooks.json` PreToolUse deny hook,
  proven live to block mutating tools even under `--dangerously-skip-permissions`.
  **This needs explicit sign-off before any real (non-test) dispatch use** —
  it's an external, model-proof mechanism, but it's the *only* one, unlike
  Claude's `--disallowedTools` or Gemini-proper's Policy Engine.
- **`/peers` push is Claude-only.** Confirmed live: an Antigravity peer
  registers but never gets `has_channel=1` — no equivalent MCP capability
  exists on that side. Antigravity peers are permanently poll-only.
- Both runtimes now write into the same `controlplane.events` table
  (`runtime` column: `claude` / `gemini` / `antigravity`), proven with a real
  row from each, not just a shared schema.

## Files
- `gemini-worker.mjs` — targets the broken plain `gemini` CLI. Reference only.
- `antigravity-worker.mjs` — the real, working, RBAC-hook-enforced worker.
- `GX1`–`GX5_RESULTS.md` — the five foundational gates.
- `ANTIGRAVITY_WORKER_RESULTS.md` — the RBAC investigation + real end-to-end proof.
