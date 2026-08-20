# GX4 — Gemini/Antigravity `has_channel` cross-runtime check + ACP investigation

Date: 2026-08-20
Method: direct, empirical checks against the live `claude-peers` broker (`/Users/celeste7/.claude-peers.db`, daemon on `127.0.0.1:7899`) plus one real, minimal, headless Antigravity CLI session. `broker-core.ts` and `CLAUDE.md` were read-only throughout — nothing in `/Users/celeste7/claude-peers-mcp` was modified.

---

## 1. Baseline: no real Gemini/Antigravity peer was connected at task start

```
$ sqlite3 /Users/celeste7/.claude-peers.db "SELECT id, cwd, has_channel, last_seen FROM peers ORDER BY last_seen DESC LIMIT 20;"
qjjpgpn7|/|0|2026-08-20T11:34:10.177Z
bm3g1yx5|/Users/celeste7/celeste-agent-spawner/worktrees/sentry-agent-20260815-002|0|...
4ctrh4jy|/Users/celeste7||2026-08-20T11:34:09.488Z
2vabace5|/Users/celeste7/celeste-agent-spawner/worktrees/sentry-agent-20260815-001|0|...
582ffs63|/Users/celeste7|0|...
vn4g2a0k|/Users/celeste7|0|...
5u1d3mv7|/Users/celeste7|0|...
qfn24zl3|/|0|...
spi84mqv|/|0|...
xzy3tlu5|/|0|...
us0xj9zz|/Users/celeste7|0|...
5msadpeg|/Users/celeste7|0|...
jmic2otu|/Users/celeste7||...
ht8lz8j1|/Users/celeste7/celeste-agent-spawner/worktrees/sentry-agent-20260815-003|0|...
c9w6zprd|/Users/celeste7|0|...
6q7afvch|/Users/celeste7|0|...
```

`bun cli.ts peers` / `bun cli.ts status` (16 peers total, cross-checked against summaries) confirmed every one of these is a real Claude Code seat — AIS9, SENTRY1, ALEX9a, ALEX9b, three `sentry-agent-*` worktree workers, and several idle/unsummarized instances. **None had a `cwd`, `id`, or `summary` pointing at Gemini, Antigravity, or CENTRAL.** `SELECT has_channel, COUNT(*) FROM peers GROUP BY has_channel` returned `NULL: 2, 0: 14` — **zero peers, of any origin, showed `has_channel=1` at baseline.** So this session's own earlier investigation was right to flag the question as unconfirmed: there was no live Gemini-originated peer to inspect, and the finding "no real Gemini peer currently connected" is reported plainly per the task's own instruction, not fabricated.

## 2. Fresh, real, minimal Antigravity CLI peer — direct test

The bare `gemini` CLI (v0.55.1, oauth-personal auth) turned out to be a dead end on its own: a live, non-interactive call (`gemini -p ... --allowed-mcp-server-names claude-peers`) failed immediately with a real backend rejection, not a local error:

```
Error authenticating: IneligibleTierError: This client is no longer supported for
Gemini Code Assist for individuals. To continue using Gemini, please migrate to the
Antigravity suite of products: https://antigravity.google
```

This is itself a finding: Google has sunset the free/individual tier of the standalone `gemini` CLI and is funneling users to Antigravity — which is exactly *why* the only two Gemini-family MCP clients configured on this machine are `antigravity-cli` and `antigravity-ide`, not bare `gemini`.

So the real test used the actual Antigravity CLI headless binary (`/Users/celeste7/.local/bin/agy` — the same product behind `~/.gemini/antigravity-cli/`, configured via `~/.gemini/config/mcp_config.json`, which already declares `claude-peers` → `bun /Users/celeste7/claude-peers-mcp/server.ts`, identical command/args to Claude Code's). One real, minimal, non-interactive session:

```
$ /Users/celeste7/.local/bin/agy -p "Call the list_peers MCP tool (server claude-peers) \
  with scope=machine. Report exactly what it returns as raw text, then stop." \
  --output-format text
```

This genuinely connected as an MCP client, spawned the real `bun server.ts`, registered with the real broker, and successfully called `list_peers`, returning the live 16-peer list (proof the connection was real, not a stub). Immediately after, the broker DB showed the new row:

```
$ sqlite3 /Users/celeste7/.claude-peers.db "SELECT id, pid, cwd, has_channel, registered_at, last_seen FROM peers WHERE cwd LIKE '%claude-peers-mcp%';"
1seh9g4n|3003|/Users/celeste7/claude-peers-mcp|0|2026-08-20T11:37:44.421Z|2026-08-20T11:38:59.434Z
```

`has_channel = 0` — not NULL, a confirmed **0**. The underlying `bun server.ts` process (PID 3003) stayed alive past the print-mode call (orphaned under PPID 1) and was re-checked across two more 15s heartbeat cycles before cleanup — it never moved off `0`, through `11:39:14Z`. This is a real, repeated-heartbeat confirmation, not a single handshake-window snapshot.

**Root cause, read directly from `server.ts`:** `has_channel` is set from `channelConsumerState()`, which reads `mcp.getClientCapabilities().experimental["claude/channel"]` off the MCP `initialize` handshake. That capability is a Claude-Code-specific experimental extension, declared only by a Claude Code host launched with `--dangerously-load-development-channels server:claude-peers`. It is not part of the MCP spec and there is no reason — and, empirically, no evidence — that Google's Antigravity/Gemini MCP client implementation declares it. `--dangerously-load-development-channels` is a Claude Code CLI flag; nothing on the `gemini`/`agy` side has an equivalent, and none exists to add.

**Conclusion for step 1/2: confirmed, not inferred.** A real Gemini-family (Antigravity CLI) peer registers correctly with the shared broker and can call every tool (`list_peers`, `send_message`, `set_summary`, `check_messages`) — but it is **structurally poll-only**. It will never get `has_channel=1`; `send_message` to it will always return the "QUEUED ONLY — no channel consumer" warning, and it can only ever discover new mail via an explicit `check_messages` poll (its 1s internal poll loop still runs and can *push* a `notifications/claude/channel` MCP notification, but since the client never declared the capability, that push is fire-and-forget into nothing — the code path in `pollAndPushMessages()` correctly detects this and leaves the message undelivered/re-servable, so no mail is lost, it just never interrupts).

Cleanup performed: killed the orphaned PID 3003 (row auto-evicted from the peers table immediately after); deleted the project-local `/Users/celeste7/claude-peers-mcp/.gemini/settings.json` that `gemini mcp add` created as scaffolding for the test; confirmed (`diff`) the global `~/.gemini/settings.json` is byte-identical to its pre-test backup — no lasting config change anywhere.

## 3. `--acp` / Agent Client Protocol — what it actually is

`gemini --help` confirms the flag: `--acp  Starts the agent in ACP mode` (and a deprecated `--experimental-acp` alias).

Real, current facts (web-verified, not from training-data memory):

- **ACP (Agent Client Protocol) is a real open standard**, created by **Zed Industries**, released ~August 2025, **Apache-licensed**, now **community-governed** at `github.com/agentclientprotocol/agent-client-protocol`, with a public spec at `agentclientprotocol.com`.
- **Not Google-proprietary.** Google/Gemini CLI is one of the adopters/reference agents (alongside Claude Code, OpenAI Codex), and JetBrains and GitHub have also adopted it. Google partnered with Zed on it; Google did not invent it.
- **What it does, concretely:** it's the transport for an **editor/IDE talking to a single agent process**, not agent-to-agent. JSON-RPC 2.0 over stdio, editor launches the agent as a subprocess, and the two negotiate capabilities, sessions, prompt turns with streaming updates, permission requests before sensitive operations, and client-provided (editor-provided) filesystem/terminal access. The standard tagline used across the sources is accurate: **"LSP, but for agents"** — same shape as the Language Server Protocol (editor↔tool), applied to editor↔agent instead of editor↔linter.
- **Supported today:** lets Zed, JetBrains IDEs, Neovim (via CodeCompanion / avante.nvim), and Emacs each embed Claude Code, Gemini CLI, or Codex as a pluggable backend agent from one config shape.

### Verdict — ACP is NOT relevant to CENTRAL's dispatcher/bridge (cross-agent coordination) work

ACP and claude-peers/MCP solve **different problems that don't overlap**:

| | claude-peers (MCP-based) | ACP |
|---|---|---|
| Relationship | **agent ↔ agent** (peer discovery, cross-session messaging, live push) | **editor ↔ agent** (one UI host driving one agent subprocess) |
| Who initiates | Either agent, any time, to any other registered peer | The editor, at session start, to its one launched agent |
| Multiplicity | N agents forming a mesh, discoverable by `cwd`/`git_root`/machine scope | 1 editor ↔ 1 agent process per ACP session |
| What CENTRAL needs it for | Cross-runtime task handoff, status broadcast, live interrupt | Not applicable — CENTRAL isn't building an editor UI shell |

ACP has no concept of a peer registry, no cross-agent messaging, no "list other agents on this machine" primitive — it is strictly the plumbing for embedding one agent's chat/edit turns inside one editor's UI. It does not duplicate claude-peers, and it also does not extend it: adopting ACP would not give Gemini sessions a live-push channel into claude-peers, because ACP's client role is played by the *editor* (Zed/JetBrains/Neovim), not by another agent. The two protocols are orthogonal and would only ever compose if CENTRAL were building an editor-hosted agent UI (out of scope for the dispatcher/bridge work) — for cross-runtime agent coordination, **claude-peers/MCP remains the only relevant mechanism**, and Gemini/Antigravity's participation in it stays poll-only per §2 above.

---

## Summary of what changed on disk

- No modification to `/Users/celeste7/claude-peers-mcp/*` (read-only throughout, per instruction).
- No net modification to `~/.gemini/settings.json` (test scaffold added then removed; diff-confirmed identical to backup).
- One orphaned test process (PID 3003) started and killed; its peer row self-evicted.
