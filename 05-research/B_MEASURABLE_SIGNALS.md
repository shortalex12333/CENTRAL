# Track B — Measurable, Non-Judgment Signals for Context Rot / Loop Detection

**Question:** besides the two tier-0 heuristics we already run for free (repeated-identical-tool-call,
turn-count cap) and the tier-2 LLM judge (CARL), what OTHER measurable signals have real evidence behind
them — not just plausibility — for detecting an agent stuck in a loop or degraded by context rot, without
asking the model to self-report?

**Method:** for each candidate, I searched for a paper, a production postmortem, or working code that
claims the signal actually correlates with degradation — not just a blog post proposing it. Where I could
not find real validation (only a proposal or a training-time analogue), I say so explicitly rather than
upgrading a plausible idea to "evidenced."

**Baseline for comparison** (what CENTRAL already has, from `03-daemon/spawn.mjs`):
```js
const looping = state.toolCalls.length >= 6 && new Set(state.toolCalls.slice(-6)).size === 1;
if (looping) emit('suspect-rot', {reason: 'repeated_identical_tool'});
if (state.turns > 40) emit('suspect-rot', {reason: 'turn_cap'});
```
Both are computed purely from fields Claude Code's `stream-json` output already emits — no extra API
calls, no LLM. That is the bar the six candidates below are measured against.

---

## Summary table

| # | Signal | Real evidence exists? | Needs new API calls / infra? | Recommend now? |
|---|---|---|---|---|
| 1 | Output/tool-call repetition (n-gram, hash-fingerprint) | **Yes** — production (8% catch rate) + real incident | No — already in stream-json | **Yes, upgrade existing heuristic** |
| 2 | Tool-call Shannon entropy | Partial — framework paper exists, correlation not independently verifiable; strong analogue in RL training | No — already in stream-json | Yes, as a secondary trend signal |
| 3 | Embedding drift from goal | Yes, but only on synthetic/simulated data | **Yes** — embedding model + storage | Not yet — prototype later |
| 4 | Tool-call failure-rate trend | **Yes** — production alerting thresholds + real incident (38 consecutive errors) | No — `tool_result.is_error` already exists | **Yes — currently NOT tracked at all** |
| 5 | Perplexity / logprobs | Yes for the underlying idea (Nature paper), but **not accessible from Claude's API/CLI** | Yes — not exposed at all; adaptation needs N extra full calls | **No** |
| 6 | Cost/turn growth-curve shape | **Yes** — Anthropic's own docs + our own G2 experiment + real incident | No — already in `result` events | **Yes — highest-value addition to the dispatcher/lineage layer** |

---

## 1. Output repetition / n-gram redundancy (distinct-n, self-BLEU, hash-fingerprint)

**Does it work?** Yes, in two different but converging bodies of evidence:

- **Free-text generation (the origin of the metric):** Holtzman et al., *"The Curious Case of Neural Text
  Degeneration"* (arXiv:1904.09751) — the paper `distinct-n` and repetition-loop analysis come from. Under
  greedy/beam decoding, models fall into repetitive loops at a rate far above human text: **43% of
  4-grams repeated in greedy continuations vs. 0.5% in human text**. This is the mechanistic root of
  "context rot" looping — a model that has locked onto a high-probability repeating pattern — even though
  the paper studies free text, not agent tool calls.
- **Agent/tool-call domain, in production, exact-match form:** a dev.to production write-up
  ("Tool-use API design for LLMs: 5 patterns that prevent agent loops and silent failures") describes a
  live deduplication guard: hash `tool_name + sha256(json.dumps(args, sort_keys=True))[:16]` over a
  sliding window of the last 5 calls, block on an exact repeat. Reported result: **this pattern caught
  ~8% of all tool calls in their production system** — i.e. real, not hypothetical, catch rate.
- **Real catastrophic incident, same signature:** [`anthropics/claude-code` issue #4095](https://github.com/anthropics/claude-code/issues/4095),
  a documented 1.67-billion-token / 5-hour runaway. The forensic breakdown found **913 identical `echo`
  commands** and **230 repetitions of the phrase "Now let me run the test again"** inside the runaway
  session — a distinct-1/self-repetition collapse is exactly what the worst real-world rot event looked
  like when someone actually went and counted.

**Gap, stated honestly:** I could not find a paper or production writeup applying *fuzzy* n-gram
metrics (distinct-n, self-BLEU) to agent tool-call **argument** streams specifically. Real practice uses
the cruder, cheaper exact-hash version (dev.to pattern above), not fuzzy overlap scoring. Treat "self-BLEU
on tool args" as unvalidated; treat "exact-match hash-fingerprint over a sliding window" as validated.

**Cost to compute:** free. Every candidate we'd need — `tool_name` and the tool's `input` JSON — is
already in every `assistant` event's `tool_use` content block that `spawn.mjs` already parses. A hash
fingerprint is a few lines added to the existing `ingest()` switch.

**Recommend:** **Yes — upgrade, don't just add.** CENTRAL's current heuristic (`Set(toolCalls.slice(-6)).size===1`)
only compares *tool names*, which is both too blunt (an auditor role legitimately calling `Read` on 6
different files in a row would false-positive) and too loose (calling `Bash` with 6 different-but-equally-
looping commands would not trip it at all). Swapping to `tool_name + hash(sorted args)` over a window of
~5, matching the validated dev.to pattern, fixes both failure directions for zero extra cost and directly
matches the real-incident signature above.

---

## 2. Action/tool-call entropy (Shannon entropy over the tool-call distribution)

**Does it work?** Split evidence:

- **Direct, inference-time framework:** *"Entropy-Based Observability for AI Agent Behavior"*
  (arXiv:2606.05872, 2026) explicitly defines **action entropy, tool entropy, and trajectory entropy**
  as trace-derived telemetry — computed purely from the sequence of actions/tool names an agent took, no
  logprobs required — for exactly this purpose (debugging rigidity/diversity of agent behavior, tool-use
  concentration). It includes a case study section ("Learning Roadmap Agent"). I could not extract the
  paper's numeric correlation results (the PDF text layer is compressed/inaccessible to automated fetch),
  so I can confirm the framework and its data requirements but **not independently verify a quantified
  correlation with failure** — flagging this rather than overstating it.
- **Strong analogue from RL training:** multiple 2026 papers (*"Cyclical Entropy Eruption: Entropy
  Dynamics in Agent Reinforcement Learning,"* arXiv:2605.27954; *"Agentic Entropy-Balanced Policy
  Optimization,"* arXiv:2510.14545) document **policy entropy collapse** during agent RL training as a
  well-established precursor to degenerate, repetitive policies and outright training collapse. This is
  the same math (Shannon entropy over an action distribution) applied to a different point in the
  lifecycle (training-time policy monitoring, not inference-time single-episode monitoring) — it validates
  the underlying mechanism ("collapsing action-distribution entropy ⇒ degenerate repeated behavior") even
  though it isn't a direct citation for watching one deployed agent's rollout.

**Cost to compute:** free — same underlying data as #1 (tool names / fingerprints already in stream-json),
just a different aggregation: `H = -Σ p_i log(p_i)` over the multiset of tool-call fingerprints in a
rolling window (e.g. last 10–20 calls).

**Recommend:** Yes, but as a **secondary/gradient signal layered on #1**, not a standalone gate. Where
#1 is a binary trip-wire (exact repeat ≥ N), entropy gives a continuous "getting worse" trend line —
useful as one more cheap, non-LLM feature to decide *when* to escalate to CARL, rather than as its own
stop authority (the correlation-with-failure evidence for this specific use is real but thinner than #1,
#4, or #6).

---

## 3. Embedding drift from stated goal/intent

**Does it work?** Real evidence exists, with a real caveat on how it was validated:

- *"Quantifying Agent Drift in Multi-Agent LLMs"* (arXiv:2601.04170) defines an **Agent Stability Index
  (ASI)** across 12 dimensions, one of which is cosine similarity between output embeddings and
  goal/reference embeddings; drift is operationally defined as **ASI < 0.75 for three consecutive rolling
  windows**. The paper reports real correlation numbers: systems flagged as "drifting" showed **a 42%
  reduction in task success rate**, a **24.9% decline in response accuracy**, and a **3.2× increase in
  required human interventions**.
- **The caveat, stated up front by the authors themselves:** this is validated on **800 synthetic
  workflows** with simulated GPT-4/Claude-3-Opus-style agents, **not real production/longitudinal logs**.
  The authors list "findings are based on simulations rather than longitudinal logs from real, production
  multi-agent systems" as their own explicit future-work gap. So: real quantified correlation, but not yet
  proven outside simulation.
- A second, adjacent paper — *"Nautilus Compass: Black-box Persona Drift Detection for Production LLM
  Agents"* (arXiv:2605.09863) — claims to target production black-box drift detection specifically; I
  did not deep-dive it, but it is a second lead worth following if we invest further here.

**Cost to compute:** **not free**, unlike every other candidate in this report. It requires (a) embedding
the original task text once (cheap, one-time), and (b) periodically embedding recent agent
output/action text and computing cosine similarity — an ongoing cost even with a local/free embedding
model, and it is **not derivable from data already in our stream-json events**; it requires reading and
processing the actual text content of tool inputs/outputs, then a separate embedding call (local model or
API) per check.

**Recommend:** Not now. Real evidence exists but only from simulation, and unlike signals 1/2/4/6 it is
not "free from data we already have" — it needs new infrastructure (an embedding model, a place to store
the goal vector, a scheduled re-embed step). Worth a future prototype once tier-0/tier-1 mechanical
signals are exhausted, not a candidate for the free tier today.

---

## 4. Tool-call success/failure rate trend

**Does it work?** Yes — this has the most directly-matching production evidence of any candidate, and
CENTRAL currently tracks **none** of it (this would be genuinely new coverage, not a refinement).

- **Production thresholds, independent sources:** industry write-ups on agent observability (Latitude,
  Openlayer, and a dev.to "Agent Observability" piece) converge on the same practice: **tool-calling fails
  3–15% of the time in production** as a baseline, with recommended alerting at **tool-call success rate
  < 95% sustained over a rolling window**, and — importantly for "independent of context length" — a
  **rising retry-rate trend (tracked as rolling p95) flagged as a sign the agent's reasoning on a specific
  intent is unstable**, distinct from and complementary to plain latency monitoring.
- **Real incident, exact match:** the same GitHub #4095 runaway that produced the repetition evidence in
  §1 also shows this signature directly: **985 error-related log mentions, 253 "usage limit reached"
  messages, 479 interrupted requests, and one session with 38 consecutive errors while the agent kept
  attempting new requests anyway** (an error cascade, not a halt). The rot event's failure-rate trend was
  not a side effect worth noting after the fact — it was one of the primary forensic markers used to
  diagnose the incident.

**Cost to compute:** free. Claude Code's `stream-json` `tool_result` content blocks already carry an
`is_error` boolean on every tool result. This is currently **not consumed at all** by `spawn.mjs`'s
`ingest()` — it only switches on `system`, `assistant`, `rate_limit_event`, and `result` event types, and
tool results arrive inside synthesized `user` events that are presently ignored. Adding a rolling
error-rate counter is a small, well-scoped addition (one new `case 'user':` branch), not a rewrite.

**Recommend:** **Yes — the single biggest genuinely-new addition to make.** It is orthogonal to
signals 1/2/6 (a loop that varies its arguments each time and keeps failing would slip past a repetition
or entropy check but not this one), matches a real catastrophic incident's own forensic signature
directly, has concrete published alerting thresholds we can copy (95% success-rate floor), and needs zero
new infrastructure — the data is already flowing past `spawn.mjs`, just not read.

---

## 5. Perplexity / token-probability (logprobs) signals

**Does it work, in principle?** Yes — the best-evidenced idea in this whole report, and the least
usable for us:

- Farquhar, Kuhn, et al., *"Detecting hallucinations in large language models using semantic entropy,"*
  **Nature 630 (2024)** — real, peer-reviewed, widely cited. Semantic entropy clusters multiple sampled
  generations by meaning (via NLI), then takes entropy over the cluster distribution, and is shown to
  detect confabulations without needing task-specific ground truth.

**Is it practical here?** No, for two separate, compounding reasons:

1. **Claude's API does not expose logprobs at all.** Confirmed across multiple sources — a community
   project (`anerli/anthropic-logprobs`) exists specifically to work around this gap, and explicitly notes
   Anthropic's API has no `logprobs`/`top_logprobs` parameter (unlike OpenAI's), recommending "a Mistral
   model is a better backup than an Anthropic model" for anyone who actually needs this. Claude Code's
   CLI `stream-json` output (what `spawn.mjs` parses) has no logprob field anywhere in its event schema.
2. **Even the semantic-entropy adaptation that avoids raw logprobs isn't free.** It requires sampling the
   **same** decision point N times at temperature > 0 and clustering the results — i.e., N extra full
   API calls per check-point, on top of the single deterministic run we're already paying for. That is
   more expensive than simply escalating the suspicious moment straight to CARL (one extra local Ollama
   call, $0).

**Cost to compute:** effectively infeasible from Claude's API/CLI as exposed today; the closest working
adaptation costs strictly more than our existing tier-2 fallback.

**Recommend:** No. Real evidence for the underlying idea, zero practical path to it on this stack.

---

## 6. Cost / turn-count growth-curve *shape* (not just the raw numbers)

**Does it work?** Yes — this is the strongest-evidenced signal in the report, and uniquely, we already
have first-party confirmation from three independent sources: Anthropic's own engineering docs, our own
measured experiment, and a real production incident.

- **Anthropic's own documentation names the exact failure shape.** ["How Claude Code uses prompt
  caching"](https://code.claude.com/docs/en/prompt-caching) states plainly: *"This is why `/compact`
  costs the most when you resume an old session"* (cold cache), and separately, resuming after any
  prefix-invalidating change is *"the most expensive request you send... reprocesses the entire
  conversation history with no cache hits."* This is Anthropic itself defining "cost that does not
  flatten" as the documented signature of a broken/cold cache state, not a hypothesis.
- **Our own measured data confirms the healthy shape, twice, in two different topologies**
  (`02-forge/results/G2_CACHE_REUSE_EXPERIMENT.md`, N=3 real API calls, real spend):
  - Sequential `--resume` turns (from the earlier G2 test 1): per-turn cost **kept dropping/flattening**
    turn over turn as history accumulated — the expected healthy shape.
  - Independent fresh sessions sharing only a static system-prompt prefix: cost dropped **34.7%** from
    call A→B (`cache_creation_input_tokens` 14365→8649, mirrored by `cache_read_input_tokens` 18139→23855,
    prefix token total identical at 32504 both times, proving it's a real cache-split shift not a
    different prompt) — then **plateaued exactly, bit-for-bit, B→C** (both calls: 8649 creation / 23855
    read). Two different healthy curve shapes (progressive flattening vs. one-time-discount-then-plateau),
    both real, both distinguishable from a curve that keeps paying cold-start/creation price every turn.
- **Real incident shows the unhealthy shape.** GitHub #4095's runaway session hit a **cache-token ratio
  of 84.7%** (abnormally *high*, meaning a huge prefix being re-read and re-billed every request) combined
  with a **224 requests/second peak** and **436 requests at 0.000-second intervals** — i.e., in the one
  real catastrophic case we could find data for, the "wrong" curve wasn't simply "cost climbs linearly" —
  it was cost climbing via an exploding *request rate* against an ever-growing re-billed prefix (matching
  a separate production write-up's framing of a "loop tax": *"the same tokens get re-billed again and
  again as the session snowballs"* — agenticcontrolplane.com, "Claude Code Cost Tracking").

**Cost to compute:** free. `total_cost_usd`, `num_turns`, `cache_creation_input_tokens`,
`cache_read_input_tokens`, and `duration_api_ms` are already emitted verbatim on every `result` event
(`spawn.mjs`'s `ingest()` already captures `state.costUsd` / `state.turns`). One real gap: `spawn.mjs`
as written only *snapshots* the latest `result` event (`-p` mode runs to one final result per process), so
per-turn curve-shape tracking needs to happen one layer up — across a `--resume` chain in
`dispatcher.mjs`/CARL's lineage bookkeeping, where multiple `result` events genuinely exist to compare.
That's a data-plumbing change, not a new data source.

**Recommend:** **Yes — highest-value addition, but it belongs in the dispatcher/lineage layer, not
`spawn.mjs` itself.** Track, per `--resume` chain: (a) `cache_read / (cache_read + cache_creation)` ratio
turn-over-turn — it should be rising toward 1.0 as a session matures; a session where creation stays high
or keeps growing turn after turn is not riding the cache and matches the exact failure Anthropic's own
docs describe; (b) cost-per-turn slope — flattening/plateauing is healthy (both shapes we measured), a
persistent near-linear or accelerating slope is not, matching the real incident's signature.

---

## Recommendation, ranked

1. **Add now, cheapest, most direct new coverage:** tool-call failure-rate trend (#4) — currently zero
   coverage in `spawn.mjs`, the data (`tool_result.is_error`) already flows past unused, published
   production thresholds exist to copy (95% success floor), and it's the one signal that would have
   caught the real GitHub #4095 incident on a dimension the other signals don't touch (repeated tool
   calls can look "diverse" in name/args while every single one is failing).
2. **Upgrade immediately, same cost, fixes a real precision gap:** repeated-tool-call heuristic (#1) —
   swap tool-name-only matching for a `tool_name + hash(args)` fingerprint over a sliding window,
   matching the validated dev.to production pattern (8% catch rate) and the real incident's own
   forensic signature (913 identical commands).
3. **Add at the dispatcher/lineage layer once multi-turn chains exist:** cost-curve-shape / cache-ratio
   trend (#6) — the best-evidenced signal overall (three independent confirming sources), but it needs
   per-turn data across a `--resume` chain that only `dispatcher.mjs` currently has visibility into.
4. **Layer in as a secondary gradient signal, not a gate:** tool-call entropy (#2).
5. **Defer:** embedding drift (#3) — real evidence, but simulation-only and needs new embedding
   infrastructure we don't have today.
6. **Do not build:** perplexity/logprobs (#5) — not exposed by Claude's API/CLI at all, and the one
   workaround that doesn't need logprobs (semantic entropy) costs more in extra API calls than falling
   back to CARL directly.

---

## Sources

- Holtzman et al., ["The Curious Case of Neural Text Degeneration"](https://arxiv.org/pdf/1904.09751) (arXiv:1904.09751)
- [dev.to — "Tool-use API design for LLMs: 5 patterns that prevent agent loops and silent failures"](https://dev.to/adamo_software/tool-use-api-design-for-llms-5-patterns-that-prevent-agent-loops-and-silent-failures-f29)
- [GitHub `anthropics/claude-code` issue #4095](https://github.com/anthropics/claude-code/issues/4095) — 1.67B tokens/5hrs incident, full forensic breakdown
- ["Entropy-Based Observability for AI Agent Behavior"](https://arxiv.org/html/2606.05872) (arXiv:2606.05872)
- ["Cyclical Entropy Eruption: Entropy Dynamics in Agent Reinforcement Learning"](https://arxiv.org/pdf/2605.27954) (arXiv:2605.27954)
- ["Agentic Entropy-Balanced Policy Optimization"](https://arxiv.org/html/2510.14545v1) (arXiv:2510.14545)
- ["Quantifying Agent Drift in Multi-Agent LLMs"](https://www.emergentmind.com/papers/2601.04170) (arXiv:2601.04170)
- ["Nautilus Compass: Black-box Persona Drift Detection for Production LLM Agents"](https://arxiv.org/pdf/2605.09863) (arXiv:2605.09863) — flagged as a lead, not deep-dived
- [Latitude — "Detecting AI Agent Failure Modes in Production"](https://latitude.so/blog/ai-agent-failure-detection-guide)
- [Openlayer — "AI Agent Failure Modes: Tool-Calling Errors, Infinite Loops & Propagation"](https://www.openlayer.com/blog/ai-agent-failure-modes-tool-calling-loops-propagation)
- Farquhar, Kuhn et al., ["Detecting hallucinations in large language models using semantic entropy"](https://ora.ox.ac.uk/objects/uuid:0653d09e-9368-4eb1-98bb-50d9dda7d3e5), *Nature* 630 (2024)
- [`anerli/anthropic-logprobs`](https://github.com/anerli/anthropic-logprobs) — community confirmation Anthropic's API has no logprobs
- [Sophia Willows — "Leveraging logprobs to build better generative AI systems"](https://sophiabits.com/blog/leveraging-logprobs)
- Anthropic — ["How Claude Code uses prompt caching"](https://code.claude.com/docs/en/prompt-caching)
- Claude.com — ["Lessons from building Claude Code: Prompt caching is everything"](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything)
- [agenticcontrolplane.com — "Claude Code Cost Tracking"](https://agenticcontrolplane.com/blog/claude-code-cost-tracking)
- CENTRAL internal: `02-forge/results/G2_CACHE_REUSE_EXPERIMENT.md` (our own N=3 measured cache-discount experiment)
- CENTRAL internal: `03-daemon/spawn.mjs` (current tier-0 heuristics and stream-json event schema in use)
