# Track D — Production War Stories: Detecting a Looping/Rotted Coding Agent

**Question:** How do companies actually running autonomous coding/browsing agents in production detect and recover from an agent that's stuck, looping, or degrading — with a *non-self-report* (mechanical/measurable) signal, not "we monitor it" hand-waving?

**Method:** Targeted search + direct fetch of first-party engineering blogs, direct read of open-source agent source code, and direct read of live GitHub issues from major agent products (as primary evidence of what's actually shipped vs. what's still a feature request). Framework docs (LangChain/LangGraph) are noted only as corroboration, per the brief's scoping to a different track.

**Bottom line up front:** almost nobody publishes a numeric "N repeated actions = kill" threshold. The two mechanisms found that are genuinely mechanical, measurable, and *verified against source* rather than a vendor's marketing copy are (1) Aider's hard-capped reflection counter, read directly out of its open-source code, and (2) Anthropic's own published harness pattern of checking actual repo/test state instead of asking the agent if it succeeded. Everything else — Devin, Cursor, Replit's "doom loop," Sourcegraph/Amp — either withholds the mechanism, or the "concrete numbers" circulating online (fingerprint hashing, "58 times," "$437 overnight") trace back to independent consultants' blog posts and anonymized anecdotes, not verified named-company disclosures.

---

## 1. Findings ranked by confidence (mechanical + verifiably real first)

### 1.1 Aider — hard-capped `max_reflections` counter (HIGH confidence: read directly from shipped source code)

Read directly from `aider/coders/base_coder.py` in the `Aider-AI/aider` repo (not a summary — actual `curl` of the raw file):

```python
num_reflections = 0
max_reflections = 3
...
if self.num_reflections >= self.max_reflections:
    self.io.tool_warning(f"Only {self.max_reflections} reflections allowed, stopping.")
    return
self.num_reflections += 1
message = self.reflected_message
```

Mechanism: every LLM turn, if the coder decides it needs to retry (lint failure, test failure, or an edit that didn't apply cleanly), it sets `self.reflected_message` and treats the next call as a "reflection." A single shared counter (`num_reflections`) is incremented on **any** reflection, from any of the three sources (edit-format failure, lint failure, test failure — confirmed by reading the surrounding code around lines 1596-1630, where `lint_errors`/`test_errors` both route into the same `reflected_message`/`num_reflections` mechanism). Once the counter hits 3, Aider stops unconditionally and prints "Only 3 reflections allowed, stopping."

- **Measurable/mechanical, not LLM-judgment:** yes — it's a plain integer counter, no model call decides whether to trip it.
- **Confidence this is real production practice:** very high — this is the actual code that ships to every Aider user, confirmed by GitHub issues (#1440, #3450) where users hit exactly this message and asked what it meant, and issue #3865 where a user requested it be made configurable (maintainers declined to make it a CLI flag; it's hardcoded).
- **Known limitation (be honest about it):** this is a **bounded-retry cap**, not true loop/repetition *detection*. It stops after 3 reflections regardless of whether those 3 attempts were 3 distinct useful retries or 3 identical failures. Issue #1090 ("If aider is unable to fix lint error, it will loop forever without adding or changing code") shows the counter doesn't catch every degenerate case — e.g. the *outer* user-confirmation loop ("Attempt to fix lint errors?" → yes → still broken → ask again) isn't gated by `max_reflections` at all in some code paths.

Source: `https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py`

### 1.2 Anthropic — "Effective harnesses for long-running agents" (HIGH confidence: first-party Anthropic engineering blog, read directly)

`https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents`

This is Anthropic's own account of building a harness that let Claude work autonomously across many multi-hour sessions on a real app build. The concrete, non-self-report mechanisms described:

- **External, boolean ground truth instead of self-report:** a structured feature list (JSON, 200+ features) where each item has a `passes` boolean. Crucially, the pass/fail is decided by actually **driving the running app with browser automation "as a human user would,"** not by asking the model whether it thinks the feature works. The prompt explicitly forbids the model from editing/removing tests to make them pass — a direct anti-gaming rule.
- **Session-start verification protocol**, run every single session before any new work: `pwd` → read git log + progress file → read the feature list → run `init.sh` → **run a basic end-to-end test first, to check whether the app was left in a broken state** by the prior session. This is the actual "is the previous agent rotted?" check — it's decided by running code, not by trusting the prior session's own claim of success.
- **Git commits as checkpoints/rollback points**, with descriptive messages, so a broken state is diffable and revertible.
- **`claude-progress.txt`** as the sole cross-session memory artifact — deliberately external to the model's own context, so a degraded/compacted context in session N doesn't corrupt what session N+1 believes happened.
- **One feature at a time**, explicitly to bound the blast radius of a single session going wrong.

- **Measurable/mechanical, not LLM-judgment:** yes for the pass/fail gate (real e2e test outcome) and the git/file artifacts; the *decision of which feature to work on next* is still LLM judgment, but the **verification that separates "done" from "still broken/looping"** is external.
- **Confidence this is real production practice:** high — first-party Anthropic publication, describing a specific, reproducible harness (not a vague "we monitor agents" claim), with a concrete example (a from-scratch app build) and specific artifacts named (`init.sh`, `claude-progress.txt`, the features JSON).
- **Caveat:** this pattern is about **cross-session** rot detection (did the *previous* autonomous session leave things broken?), not **mid-session, live** loop detection while a single agent process is actively spinning. It doesn't give you a way to notice a subprocess is looping *while it's still running* — only a way to catch it at the next checkpoint.

### 1.3 Anthropic — "How we built our multi-agent research system" (MEDIUM-HIGH confidence: first-party, but guardrails are mostly prompted, not enforced)

`https://www.anthropic.com/engineering/multi-agent-research-system`

Concrete mechanisms confirmed by direct fetch:

- **Full production tracing** of "agent decision patterns and interaction structures" (explicitly *not* conversation contents, for privacy) used to diagnose why agents failed, after the fact — this is real observability infrastructure, not self-report.
- **Prompted effort-scaling rules** bounding tool-call budgets per task class ("simple fact-finding = 1 agent, 3-10 tool calls; direct comparisons = 2-4 subagents, 10-15 calls each; complex research = 10+ subagents") — this is a *soft* guardrail: it's an instruction in the system prompt, enforced by the model choosing to follow it, not a hard-coded counter that kills the run. Anthropic's own phrasing is "guardrails to prevent the agents from spiraling out of control," without disclosing an automated kill mechanism tied to a specific number.
- **Resumability instead of restart-on-error**: "systems that can resume from where the agent was when the errors occurred," combined with informing the agent a tool failed so it can adapt, rather than blind retry.
- **Rainbow deployments**: gradually shifting traffic from old to new agent versions so a live long-running agent isn't killed mid-flight by a deploy — this is an infra reliability pattern, not a rot-detection one, but it's concrete and specific.

- **Measurable vs. LLM-judgment:** mixed — the tracing/clustering is mechanical; the actual "stop this subagent, it's over budget" enforcement is not spelled out as a hard-coded circuit breaker in what Anthropic published. This reads as **genuinely real** (matches how the Research feature actually behaves) but **not fully disclosed** on the loop-detection question specifically — Anthropic does not publish a number here.

### 1.4 Replit Agent — "Decision-Time Guidance" doom-loop recovery (MEDIUM confidence: first-party blog, concrete recovery mechanism, vague detection thresholds)

`https://replit.com/blog/decision-time-guidance` (redirects from `blog.replit.com`)

- **Detection side (vague):** doom loops are identified via "repeated failed attempts, circular edits, or high-risk changes" — no disclosed threshold (no "N attempts," no "M identical diffs").
- **Recovery side (concrete and interesting):** on detection, Replit injects a reminder telling the agent to consult an **external agent instance running a different model**, which generates a fresh plan from **clean context**, unpolluted by the failed trajectory. Replit frames this via the "generator-discriminator gap": a model anchored to a failing trajectory struggles to *generate* its way out, but can more easily *recognize* a good plan when a differently-conditioned model hands it one. This is a specific, non-obvious architectural choice (cross-model consultation, not just "retry with same model") that's plausible as a real mitigation for the self-anchoring failure mode.
- **Confidence:** presented as already shipped ("has proved to be an effective paradigm"), not aspirational — but no metrics, no rollout data, no before/after numbers are given, so treat the *effectiveness claim* as marketing-adjacent even though the *mechanism description* reads as genuine engineering.

### 1.5 Replit — "Telescope" trace clustering (MEDIUM confidence: first-party, describes a real internal tool, but it's offline analysis, not inline circuit-breaking)

`https://replit.com/blog/evaluating-and-improving-agent-at-scale`

Replit built an internal system called **Telescope** — "our system for trace analysis and clustering" — that summarizes failure trajectories, embeds them, runs **density-based clustering** to find emergent failure modes, and classifies new incoming sessions against the evolving cluster distribution. This is the closest thing found in the whole search to "a company built an actual mechanical, non-self-report detector for bad agent behavior from raw traces" — it's exactly the shape of thing CENTRAL would want to build. The limitation: as described, it's used by Replit's own engineers/support to *find new bug classes* and prioritize fixes, not (as published) wired up as a live per-session automatic kill-switch. Also paired with **A/B testing every agent-affecting change** (prompts, tools, harness, model swaps) before rollout — a real production practice, no numbers disclosed.

### 1.6 Devin / Cognition — problem confirmed in production, mechanism never disclosed (LOW-MEDIUM confidence, but useful as negative evidence)

`https://cognition.com/blog/dec-24-product-update-2`

Direct quote: *"If you've noticed Devin stuck on the same action or unable to sleep/wake up, please let us know... These issues should not happen again... we're happy to refund your ACUs if they do!"*

This confirms the exact failure mode CENTRAL cares about was happening in a real, funded, production agent product as recently as their Dec-2024 update — and Cognition's public response was a refund policy and a bug-report channel, **not** a disclosed detection mechanism. Devin does have visible related affordances: pre-task confidence indicators (🟢🟡🔴) so a low-confidence plan pauses for human approval before execution, and a test-driven self-correction loop (read failing test output → hypothesize fix → apply → rerun). Neither is described anywhere as a "the agent is looping, kill it" detector. Treat this source as: **strong confirmation the problem is real in production at a leading agent company; zero disclosure of how/whether they solved it.**

### 1.7 Cursor (Anysphere) — no first-party disclosure found (finding: absence of evidence)

No Cursor/Anysphere engineering blog post was found describing internal safeguards against runaway/looping agent behavior. What surfaced instead was third-party security research (Backslash Security) showing Cursor's "YOLO mode" (auto-run) denylist can be bypassed multiple ways, and generic third-party "best practices" listicles recommending iteration caps/approval gates — none of it sourced to Cursor engineering. **Report this as a gap**, not a finding: Cursor does not appear to publish how (or whether) Agent mode detects runaway loops.

### 1.8 GitHub Copilot coding agent / OpenAI Codex CLI / SWE-agent — live GitHub issues as evidence the problem is unsolved in shipped products (MEDIUM confidence — these are primary-source bug reports, but they show the *absence* of a shipped fix)

Read directly (not just search snippets) for one of these:

- **OpenAI Codex CLI, issue #27588** ("Codex gets stuck in a pre-write context compaction loop... repeatedly re-reading instructions and never reaching file edits"): the reporter explicitly proposes the fix that doesn't exist — *"Add automatic pre-write loop detection. If Codex reads the same instruction/state files multiple times without file edits or new useful output, it should stop and write a short status report,"* plus explicit phase tracking and a hard 10-15 minute no-progress guard. **Zero maintainer response as of the fetch.** This is a live, named, currently-shipped product with an open feature request for the exact capability CENTRAL is trying to build itself — i.e., direct evidence this is *not* a solved problem industry-wide.
- Other open Codex CLI issues (search-surfaced, titles alone are informative): #8481 "stuck in compaction loop," #13140 "stuck in a deadlock," #14314 "stuck on 'Waited for background terminal,'" #37937 "a repeatedly blocking Stop hook can trap Codex CLI in an infinite no-escape loop."
- **SWE-agent/SWE-agent, issue #971** (read directly): a concrete, reproducible alternating loop — model outputs prose with no tool call → harness replies "Your last output did not use any tool calls!" → model calls `submit` → `submit` produces no output → repeat. Logged at length with step numbers. Filed as a `question`, **no fix, no maintainer response, no detection mechanism discussed.**
- **GitHub Copilot coding agent, community Discussion #178998**: users report the agent times out on long-running pre-commit hooks (~3-6 min), wrongly assumes the commit succeeded, retries, and loops until session credits are exhausted — a real, currently-reported production failure mode with no documented fix.

Taken together, these are the most epistemically honest data point in this report: **three separate, currently-shipped, heavily-used coding-agent products (Codex CLI, Copilot coding agent, SWE-agent) all have open, unresolved, user-filed reports of exactly the stuck/loop failure mode**, with no publicly disclosed automatic detection/recovery mechanism in any of them as of the issue dates. This directly counters any assumption that "surely OpenAI/GitHub have already solved this" — the primary evidence says they have not shipped a public fix.

### 1.9 Sweep.dev — no evidence found

No engineering content, blog post, or relevant GitHub discussion was found describing how Sweep (or its current fork, `Upsonic/sweep`) handles infinite loops or retry limits. Report as **not found**, not as "they don't have one" — absence of search results is not proof of absence.

### 1.10 "Loop fingerprinting" pattern — mechanically the closest match to what CENTRAL wants, but provenance is thin (LOW-MEDIUM confidence — reads as informed synthesis/consulting content, not a verified named-company disclosure)

Surfaced via multiple independent blog posts (`particula.tech/blog/stop-ai-agents-looping-same-tool-call-no-progress`, and a piece at `stevekinney.com/writing/agent-loops`, both read where fetchable). The pattern, stated plainly:

- Hash each iteration's `(tool_name, result_preview)` tuple.
- If **3 identical fingerprints appear in a row**, the agent is stuck — trip the breaker.
- Pair with a hard step cap (15-25 steps cited as "typical production values"), a wall-clock ceiling (300s per step cited as one example), and a cost ceiling (~$2/run cited as one example).
- One post claims: *"One production system saw the same answer repeated 58 times before anyone intervened"* — **but does not name the company or system.** This is an anonymized anecdote, unverifiable, functioning rhetorically to motivate the pattern rather than as a citable case study.

This is exactly the shape of "non-self-report, mechanical" detector CENTRAL is asking for — but I could not verify it's something a named production company actually ships (as opposed to a plausible best-practice write-up by an independent engineer/consultant). Treat the **mechanism** as a credible, implementable idea; do not treat the **"58 times" / "one production system"** framing as a verified case study.

### 1.11 Framework-level circuit breakers (out of this track's scope, noted only as corroboration)

Per the brief, framework docs are covered elsewhere, but two widely-deployed OSS agent frameworks were encountered incidentally and are worth a one-line note because they corroborate that hard step-count caps are the industry's actual default, not fingerprinting or LLM-judgment: **LangChain's `AgentExecutor`** defaults `max_iterations=15`; **LangGraph** defaults `recursion_limit=25` and raises `GraphRecursionError` when hit (confirmed via multiple live GitHub issues, e.g. `langchain-ai/langgraphjs#1524`, showing users regularly hit this ceiling in real multi-tool agents and have to raise it — itself informative: the *default* is tuned low enough to trip in normal legitimate use, suggesting these caps are blunt instruments, not smart loop detectors).

---

## 2. Direct answers to the brief's seven leads

1. **Cognition/Devin** — confirmed the failure mode in production (Dec-2024 update), mechanism never disclosed. See §1.6.
2. **Cursor/Anysphere** — no first-party engineering disclosure found. See §1.7.
3. **Replit Agent** — two real first-party mechanisms found and read directly: Decision-Time Guidance (doom-loop → cross-model plan consultation) and Telescope (trace clustering for failure-mode discovery). See §1.4, §1.5.
4. **Aider (open source, code checked directly)** — `max_reflections = 3`, a hardcoded bounded-retry circuit breaker, confirmed by reading `base_coder.py`. See §1.1.
5. **Sweep.dev** — nothing found. See §1.9.
6. **Anthropic's own customer/production case studies** — the two most relevant are Anthropic's *own* engineering posts (harness pattern, multi-agent research system), which double as their own "customer" of Claude at scale. Both read directly. See §1.2, §1.3. No third-party customer case study naming a specific loop-detection circuit breaker was found in this pass.
7. **General search terms** — surfaced the fingerprinting pattern (§1.10), the framework defaults (§1.11), and, importantly, the open GitHub issues on Codex CLI / Copilot / SWE-agent (§1.8) showing this is still an unsolved problem in production-grade shipped tools, which is itself a finding worth acting on.

---

## 3. What this means for CENTRAL

CENTRAL spawns headless Claude Code CLI subprocesses from a control plane — i.e., it sits exactly where Anthropic's own harness post and Replit's Telescope sit: **outside** the agent process, able to observe artifacts the agent can't fake by self-report. The most credible, load-bearing pattern across everything found is not any single company's secret sauce — it's the same idea appearing convergently in the two highest-confidence sources (Aider's code, Anthropic's harness post): **judge the agent by external, mechanical artifacts, never by asking it.**

Concretely, three things worth adopting, all independently verified in this pass:

- **A bounded-retry counter**, à la Aider's `max_reflections` — cap consecutive self-correction cycles per subprocess at a small fixed number (Aider ships with 3), and stop unconditionally when it's hit, regardless of what the model says about its own progress.
- **A tool-call/action fingerprint check** (§1.10) — hash the (action, args, result) of each step CENTRAL can observe from outside the subprocess (e.g., which file was touched, what the diff was, what command ran) and trip on N consecutive identical fingerprints. This is the one mechanism found that's purpose-built for *live, mid-session* detection rather than end-of-session review.
- **External ground truth over self-report**, à la Anthropic's harness (§1.2) — CENTRAL can check `git diff`/`git log` activity, test/build exit codes, and file mtimes on the actual worktree a subprocess is operating in, rather than trusting the subprocess's own stdout claim of "done" or "still working." This is the most directly transferable idea, since CENTRAL, like Anthropic's harness, sits outside the agent and can observe the filesystem/git state the agent is supposedly changing.

None of these three is a company's fully-disclosed, battle-tested "here is our exact production circuit breaker" — that specific artifact does not appear to exist in public writing from any of the companies searched. What exists is: one hardcoded, shipped, verifiable OSS implementation of idea #1 (Aider); one first-party disclosure of idea #3 (Anthropic); and a plausible, mechanically sound but unverified-provenance write-up of idea #2. Combining them is a defensible synthesis, not a single proven-at-scale pattern lifted wholesale from one named company.

---

## 4. Sources

- Aider source: `https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py`
- Aider issues: `https://github.com/Aider-AI/aider/issues/1440`, `#3450`, `#3865`, `#1090`, `#1842`
- Anthropic — Effective harnesses for long-running agents: `https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents`
- Anthropic — How we built our multi-agent research system: `https://www.anthropic.com/engineering/multi-agent-research-system`
- Anthropic — Effective context engineering for AI agents: `https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents`
- Replit — Decision-Time Guidance: `https://replit.com/blog/decision-time-guidance`
- Replit — Closing the loop: Evaluating and improving Replit Agent at scale: `https://replit.com/blog/evaluating-and-improving-agent-at-scale`
- Cognition — Devin Dec '24 Product Update (Part 2): `https://cognition.com/blog/dec-24-product-update-2`
- Cognition — How Cognition Uses Devin to Build Devin: `https://cognition.com/blog/how-cognition-uses-devin-to-build-devin`
- Backslash Security — Cursor YOLO-mode denylist bypass: `https://www.backslash.security/blog/cursor-ai-security-flaw-autorun-denylist`
- OpenAI Codex CLI issues: `https://github.com/openai/codex/issues/27588`, `#8481`, `#13140`, `#14314`, `#37937`, `#11897`, `#26745`
- SWE-agent issue: `https://github.com/SWE-agent/SWE-agent/issues/971`
- GitHub Copilot coding agent discussion: `https://github.com/orgs/community/discussions/178998`
- "Loop fingerprinting" pattern write-ups: `https://particula.tech/blog/stop-ai-agents-looping-same-tool-call-no-progress`, `https://stevekinney.com/writing/agent-loops`
- $437 overnight-loop postmortem (individual account, unverified beyond the post itself): `https://earezki.com/ai-news/2026-04-29-i-let-my-ai-agent-run-overnight-it-cost-437/`
- LangChain/LangGraph defaults (framework corroboration only): `https://docs.langchain.com/oss/python/langgraph/errors/GRAPH_RECURSION_LIMIT`, `https://github.com/langchain-ai/langgraphjs/issues/1524`
