# CENTRAL — Agentic Control Plane

A local-first control plane for an autonomous AI workforce, orchestrating four assets
(CelesteOS/Yacht PMS, Celeste Data HQ, MYI insurance blogging, Influence relationship
ontology) from a Mac Studio execution brain, with cloud used only for state and UI.

Full architecture: [`00-context/BLUEPRINT_INTERNALISED.md`](00-context/BLUEPRINT_INTERNALISED.md).

## Working discipline

Every layer gets a standalone, falsifiable test before anything is built on top of it — a
numbered dependency graph of gates (G0–G10), each with a pre-registered pass/fail condition.
No layer is trusted on a verbal claim. See
[`02-forge/BUILD_AND_TEST_BLUEPRINT.md`](02-forge/BUILD_AND_TEST_BLUEPRINT.md) for the full
graph, and `02-forge/results/` for every gate's raw evidence.

## Layout

- `00-context/` — the source blueprint and its internalised summary.
- `01-audit/` — legacy repo audit (JARVIS harvested, `unified-terminal` rejected) and the
  first execution-layer feasibility tests.
- `02-forge/` — the gate blueprint, SQL schema, gate result reports, and test scripts.
- `03-daemon/` — the actual runtime primitives: `spawn.mjs` (headless worker spawn),
  `ingest.mjs` / `dispatcher.mjs` (Sentry-style error routing with a fallback-to-human path).
- `logs/` — raw NDJSON from early feasibility probes.

## Status (see the blueprint for current numbers)

G0/G1/G3/G4/G5/G7 passing. G2 (compaction) is under active revision — Claude Code's native
`/compact` and `--input-format stream-json` persistent-worker mode changed the design after
the first test's naive comparison was shown to be unfair to compaction. G9 (Vercel UI) is
the current open gate.
