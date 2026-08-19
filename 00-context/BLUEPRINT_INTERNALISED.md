# Agentic Control Plane — Internalised Model
Source: `00-context/Agentic Control Plane Blueprint.pdf` (5pp, read in full 2026-08-19)
Seat: CENTRAL (meta-orchestrator). Working root: `/Users/celeste7/Documents/CENTRAL`

## The one-sentence vision
A centralised digital office in which an autonomous AI workforce operates four
company assets under one dashboard — with the expensive part (reasoning + code
execution) run for free on owned local hardware, and the cloud reduced to state
and glass.

## Separation of concerns (the load-bearing idea)
| Layer | Host | Owns | Must NOT own |
|---|---|---|---|
| **Brain** — execution | Mac Studio, 96GB | multi-agent execution, local FS writes, local LLM hosting, cron | persistent shared state, public ingress |
| **Memory** — state | Hetzner | PostgreSQL (agent ontology), Redis (webhook/scrape queue), inbound webhooks | code execution, agent reasoning |
| **Face** — UI | Vercel / Next.js | ontology graph render, Slack-equivalent chat, WebSocket read/write | business logic, direct FS access |
| **Bridge** | Cloudflare Tunnel / Tailscale on the Mac | outbound-only two-way WS | any open inbound router port |

Rationale: avoids containerising coding environments in the cloud, kills latency
on local file ops, and maximises ROI on hardware already bought.

## Portfolio under management
- **CelesteOS** — yacht PMS. Supabase, Vercel, Cloudflare, Render, Sentry, Linear.
- **Celeste Data HQ** — scraping/data engine on Hetzner (e.g. AIS tracking).
- **MYI** — automated blogging/marketing, Vercel + Google Tracking.
- **Influence** — human-relationship ontology; asset valuation, transaction
  metrics, targeting. Currently Vercel + an Excel MVP database.

## Execution mechanics
- **Headless multiplexing:** one isolated subprocess per agent role,
  `claude -p --output-format stream-json --dangerously-skip-permissions`.
  Structured JSON events stream to the daemon — parseable at every step, never
  to a human terminal.
- **CARL supervisor (zero-cost):** a quantised ~70B local model (Ollama / MLX)
  reads those JSON streams continuously. On detecting cyclical reasoning or
  context bloat it halts the CLI, compresses state into a handoff artifact, and
  injects it into a freshly spawned agent. Monitoring costs no API credits.
- **Cron/batch:** local scheduler on bare metal — health checks, repo pulls,
  cleanups.

## Sentry → Agent fault pipeline
Sentry error in CelesteOS → webhook to Hetzner endpoint → payload de-noised,
raw stack trace onto Redis → Mac daemon polls the queue over the tunnel →
daemon queries local DB for which agent node **owns that code path** → spawns a
headless Claude instance *in that directory* with the stack trace as the opening
prompt. Async by design so external faults never crash the daemon.

## The UI ("Agent Slack")
- **Ontology visualiser:** React Flow (± GSAP/Three.js), DB schema flattened
  into nodes = departments and agents. Reuses logic already built for Influence.
- **Live sockets:** stream-json events pushed up the tunnel in real time.
- **Slack interface:** click a node → its channel. Watch live terminal output,
  read Agent A ↔ Agent B traffic, or type — the message travels down the tunnel
  and is injected into the running subprocess's stdin.

## Build vs buy
Fork established protocols; don't reinvent.
- **Spot-check gate on every cloned repo:** (1) `stream-json` parsing capability,
  (2) genuine MCP adherence including "Code Mode". A repo failing either is
  rejected and deleted, not modified — flag and await instruction.
- Governance: Agent Governance Toolkit / Agent Control — evaluate tool calls,
  enforce RBAC, block prompt injection.
- Graph: fork React Flow for drag-and-drop departmental ontology primitives.

## Must be custom-built (the glue)
1. `carl_state_checkpointer` — local MLX/Ollama context-decay detector + handoff injector.
2. `sentry_dispatch_router` — Hetzner trace → owning CelesteOS node mapping.
3. `inter_agent_websocket_broker` — deterministic JSON schema for cross-project
   (MYI ↔ CelesteOS) variable passing without leakage or hallucination.

## Component ledger (blueprint §10)
| Component | Status |
|---|---|
| `mac_execution_daemon` | To Be Created |
| `dashboard_ontology_ui` | To Be Created |
| `carl_state_supervisor` | To Be Created |
| `legacy_jarvis_config` | Reviewed / Needs Refactoring |

## Legacy Jarvis/Kenki audit rule
**Retain:** Supabase schemas · ElevenLabs API hooks (future voice) · established
hierarchical topology definitions mapping company structure.
**Refactor out:** any context-rot logic depending on full-history dumps —
migrating exclusively to precise state extraction (the CARL method).
**Risk on record:** legacy code may conflict with new comms standards if not
filtered carefully during audit.

## Design posture
Tokenised design system. Functionality first, generic styling accepted; the
brand sheet lands globally in one update once mechanics are proven.

## Immediate action plan (blueprint §11.2)
1. Establish the secure tunnel (Cloudflare Tunnel or Tailscale) on the Mac.
2. Spin up the Next.js UI skeleton on Vercel as a tokenised visual testbed.
3. Data-flow test: trigger an event on the Mac daemon, verify it surfaces in the cloud UI.
