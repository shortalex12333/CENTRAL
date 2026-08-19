# G2 Prior-Art Survey — How Real Systems Handle Context Rot / Compaction

Commissioned after G2 (`02-forge/results/G2_RESULTS.md`) empirically REFUTED our working assumption
that compaction (fresh session + extracted summary) beats naive `--resume` on cost. At 12-turn scale,
compaction was **4.63x more expensive** and 15% slower than resume, because resume rides Anthropic
prompt-cache reads on the accumulated prefix while a fresh session pays full cold-start/cache-write
price with nothing to amortize it. This survey asks: what do the people who actually built this stuff
(Anthropic itself, LangGraph, Letta/MemGPT) know that our G2 test design didn't account for — and is
there a concrete fix?

**Headline finding, stated up front:** our G2 compaction design does not match how Claude Code's own
`/compact` actually works, and that mismatch — not the "compaction is a bad idea" conclusion — is most
likely why it lost. Claude Code's `/compact` stays inside the *same* session/prefix (system prompt +
tools + project-context stay cached) and only replaces the message-history layer; G2's compaction opened
a genuinely new `session_id`, which is a full cache miss on everything, including the ~1-2K tokens of
system prompt and tool schema that resume gets for ~10% price. See §4 and the Recommendations below.

---

## 1. Anthropic's own published guidance on context management

Anthropic has two directly relevant, current documents, plus a July 2025 third-party study Anthropic's
own guide cites approvingly.

- **["Effective context engineering for AI agents"](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)**
  (Anthropic Engineering blog). Names "context rot" explicitly: *"as the number of tokens in the context
  window increases, the model's ability to accurately recall information from that context decreases"* —
  framed as *"a performance gradient rather than a hard cliff."* States compaction's purpose plainly:
  *"Compaction is the practice of taking a conversation nearing the context window limit, summarizing
  its contents, and reinitiating a new context window with the summary,"* and that it *"typically serves
  as the first lever in context engineering to drive better long-term coherence."* Guidance on doing it
  well: *"maximize recall... then iterate to improve precision by eliminating superfluous content."*
  **Notably absent: any cost argument.** The entire justification given is quality/coherence, never
  dollars. This directly confirms our post-G2 reframe (compaction is a correctness intervention, not a
  cost optimization) — Anthropic's own document never claims otherwise.

- **["How Claude Code uses prompt caching"](https://code.claude.com/docs/en/prompt-caching)** (Claude
  Code docs). This is the single most load-bearing source in this survey — it documents the exact
  mechanism our G2 test needs to redesign around. Key facts, verbatim:
  - Cache lookup is **prefix-exact, not conversation/session-scoped**: *"The API caches by matching the
    start of each request... The match is exact... There is no per-file or per-segment caching."*
  - Claude Code's own `/compact` **does not open a new session**: *"Claude Code reuses the system prompt
    layer and reloads project context from disk... To produce the summary, Claude Code sends a separate
    request with the same system prompt, tools, and history as your conversation, plus a summarization
    instruction... While the cache is warm, that request reads your prefix from the cache, so a
    mid-session `/compact` costs a fraction of what the context size suggests."*
  - The exact failure mode G2 hit is named directly: *"This is why `/compact` costs the most when you
    resume an old session"* (cold cache) — and separately, resuming a session after any prefix change
    (e.g. a version upgrade) is flagged as *"the most expensive request you send"* because it "reprocesses
    the entire conversation history with no cache hits."
  - There is a **built-in cheaper alternative to full compaction we may be duplicating**: `/rewind`
    truncates back to an earlier turn's *already-cached* prefix rather than building a new one, and
    Claude Code offers **auto resume-from-summary** on long-idle sessions on subscription plans.
  - Auto-compact fires at **~95% of context capacity**; community guidance (ClaudeLog, multiple
    practitioner posts) converges on manually compacting earlier, around **60% utilization**, because
    summary quality degrades if you wait until near-limit to compress ([ClaudeLog auto-compact
    FAQ](https://claudelog.com/faqs/what-is-claude-code-auto-compact/)).

- **["Lessons from building Claude Code: Prompt caching is everything"](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything)**
  (Claude.com blog) — the design-rationale companion piece. Confirms the compaction mechanism from the
  first-party engineering side: *"When context fills, Claude Code forks a cached call using identical
  system prompts and tools as the parent session, appending compaction instructions as a new message.
  This reuses the cached prefix rather than starting fresh, dramatically reducing compaction costs."*
  Also generalizes the lesson we need: mid-session changes that alter the cached prefix (model switch,
  MCP server connect/disconnect, tool-set change) are treated as expensive events to be minimized, to the
  point that *"it would actually be more expensive to switch to Haiku than to have Opus answer"* once a
  large cache is built — cache warmth can outweigh a cheaper model's sticker price.

- **[Chroma Research, "Context Rot: How Increasing Input Tokens Impacts LLM Performance"](https://www.trychroma.com/research/context-rot)**
  (July 2025, 18 frontier models including Claude) — this is the empirical study Anthropic's guide is
  built on. Not just retrieval failure: *"adding irrelevant context... significantly impacts a model's
  ability to maintain reliable performance"* even on reasoning tasks with the relevant info present, and
  on the Repeated-Words stress test *"models generated random or hallucinatory content starting around
  500–750 words"* — a **generation-quality collapse**, not merely "couldn't find the fact." Claude models
  specifically showed a distinct failure mode versus GPT: increased abstention under uncertainty rather
  than confident hallucination.

**What we should actually do differently:** stop measuring compaction against a bar ("beats resume on
cost") that Anthropic's own docs never claim it should clear — and redesign compaction to fork the
existing cached session (reuse system-prompt + tool-schema cache) rather than opening `session_id: new`,
which is the literal mechanism Claude Code itself uses and G2 did not replicate.

## 2. LangGraph's checkpointing/state model

[LangGraph memory docs](https://docs.langchain.com/oss/python/langgraph/add-memory). LangGraph provides
**no automatic decision logic at all** — this is a meaningful negative finding, not a gap in our search.
It ships primitives (`trim_messages` with a developer-set `max_tokens`, `RemoveMessage`/`REMOVE_ALL_MESSAGES`
for explicit deletion, a `summarize_conversation` node pattern) and leaves *when* to trigger them, *what*
counts as safe to drop, and *how much* to keep entirely to the graph author. There is **no mention
anywhere in the docs of provider-side prompt-caching economics influencing checkpoint or state-size
decisions** — LangGraph's model treats context management purely as a token-budget/correctness problem,
never a cache-hit-rate problem. This is a genuine gap in the industry's most popular agent-orchestration
framework, not something we failed to find.

**What we should actually do differently:** don't look to LangGraph for a caching-aware compaction
policy — it doesn't have one. If we want that, we have to build it ourselves (as this survey recommends
in §4), because no popular framework surveyed here has solved "compact AND stay cache-warm."

## 3. MemGPT / Letta's tiered memory

[MemGPT: Towards LLMs as Operating Systems (arXiv:2310.08560)](https://arxiv.org/abs/2310.08560) and the
current [Letta](https://www.letta.com) implementation. Three tiers: **core memory** (always in-window,
LLM-editable persona/user blocks), **recall memory** (searchable prior conversation, outside the window),
**archival memory** (long-term vector store, queried via tool call). The eviction trigger is a hard,
pre-registered **token-threshold state machine**, not a cost calculation:
- **Warning threshold ~70% of context window** — the queue manager injects a "memory pressure" system
  message, giving the LLM a chance to proactively call `archival_memory_insert` / `core_memory_append`
  before space runs out.
- **Flush threshold ~100%** — a hard eviction of the queue (FIFO), replacing evicted content with a
  recursive summary held as the first queue entry.

This is purely a **hard-token-limit** mechanism. **We found zero evidence that MemGPT/Letta's design
accounts for provider-side prompt-caching economics at all** — the entire mechanism predates and is
orthogonal to Anthropic-style prompt caching; it exists to avoid `context_length_exceeded` errors, not to
minimize `$/turn`. This matches the LangGraph finding: neither major "memory framework" in this space has
thought about cache-hit-rate as a first-class design constraint. Anthropic's own Claude Code team is, as
far as this survey found, the only party treating cache-prefix-preservation as a top-level design
objective (§1).

**What we should actually do differently:** MemGPT's percentage-of-window trigger (70%/100%) is a cleaner,
more portable pre-registration than "12 turns" or "50 turns" — CARL's halt/compact decision should key off
**token-budget fraction of the model's context window**, not turn count, matching both MemGPT's and
Claude Code's own (~60-95%) practice.

## 4. Can a "fresh" session be made cheap via prefix-identical priming?

**Yes — this is confirmed directly and changes the G2 conclusion materially.** Two separate,
independently-fetched primary sources agree:

- [Claude Code prompt-caching docs](https://code.claude.com/docs/en/prompt-caching): *"any two requests
  with the same model and prefix read the same cache"* — cache scope is **organization/workspace +
  model + byte-exact prefix hash**, full stop. It is explicitly **not** tied to a conversation ID,
  session object, or `session_id`. The docs even describe the intended cross-process use case: "For
  Agent SDK callers running fleets of automated processes, see improve prompt caching across users and
  machines to suppress the per-machine sections of the system prompt and share the cache across
  machines" — i.e., Anthropic's own SDK guidance is to engineer multiple *independent* processes to share
  one cache lineage by keeping their prefixes byte-identical.
- [Claude Platform docs — prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching):
  *"Exact matching: Cache hits require 100% identical prompt segments... up to and including the block
  marked with cache control."* Cache key = **hash of (tools, system, messages) up to the breakpoint**,
  scoped by workspace/org, **not** by conversation ID. Two unrelated conversations (different users,
  different topics) sharing an identical system prompt through the breakpoint get a cache hit on that
  shared portion (docs give a worked example of exactly this). Lookback window for finding a matching
  cache entry is 20 blocks back from the breakpoint. TTL is 5 min (free) or 1 hr (2x write-price
  surcharge), reset on every hit, measured from request-start not response-end.

**Direct implication for our G2 architecture:** G2's sub-test 3 opened a brand-new `session_id` and paid
full price for the system prompt + tool schema (the fixed ~1-2K token "cold start" the RESULTS doc
already identified as the likely culprit). That fixed cost is **avoidable**, per Anthropic's own docs,
without needing the same `session_id` at all — a brand-new process/session_id whose **first N blocks
(tools, system prompt) are byte-for-byte identical** to a prefix already resident in the org's cache
(e.g., warmed by the resumed session, or by a standing "keep-alive" ping) would cache-hit on those blocks
even under a different session/conversation ID. G2 never tested this configuration — it tested "cold
fresh session" against "warm resumed session," which is the least favorable comparison for compaction
possible.

**What we should actually do differently:** redesign the compaction path two ways, in priority order:
(a) prefer Claude Code's own mechanism — fork the *same* session/prefix and append the summarization
instruction as a message, exactly as `/compact` does — so system-prompt+tools stay cache-warm and only
the conversation layer resets; (b) where a truly separate process/session_id is unavoidable (e.g. CARL
spawning an independent headless worker), guarantee its system-prompt-and-tool-schema bytes are
identical to a prefix Anthropic's cache already has warm from another concurrent/recent process in the
same workspace, so it can cache-hit on that shared prefix even under a different session_id.

## 5. "Lost in the middle" — is there real evidence of quality degradation independent of cost?

Yes, and it is well-established, not just intuition, across multiple independent studies with different
authors, models, and years:

- **[Liu et al., "Lost in the Middle: How Language Models Use Long Contexts," arXiv:2307.03172](https://arxiv.org/abs/2307.03172)**
  (2023, published TACL 2024) — the foundational result. U-shaped accuracy curve: performance is highest
  when relevant info is at the start or end of context and **degrades by more than 30%** when it's in the
  middle, replicated across **six model families** (GPT-3.5-Turbo, GPT-4, Claude 1.3, LongChat-13B,
  MPT-30B, Cohere Command) on multi-document QA and key-value retrieval. Architectural root cause tied to
  RoPE's long-term positional decay plus softmax's amplification of primacy/recency.
- **[Chroma Research, "Context Rot"](https://www.trychroma.com/research/context-rot)** (2025, 18 frontier
  models incl. Claude) — the more directly relevant follow-on, because it shows the effect is **not
  reducible to retrieval failure**. On LongMemEval, giving the model *only the relevant portion* of a
  ~113K-token conversation scored materially better than giving it the full transcript with the same
  relevant portion present — i.e., irrelevant context actively degrades reasoning even when the answer is
  technically "in there." On a stress test (Repeated Words), models didn't just fail to retrieve — they
  **hallucinated novel content** starting around 500-750 words, a generation-quality collapse. Distractor
  content (plausible-but-wrong information) degrades answers more than equal-length neutral filler.
- Anthropic's own engineering blog (§1) adopts "context rot" as the name for this and frames it as the
  primary justification for compaction — independent of, and never citing, cost.

**What we should actually do differently:** G2 tested correctness-at-12-turns and found it held (both
recall answers were exactly right) — but 12 turns / a few KB is far below where the cited literature
shows degradation onset (Chroma's cliffs appear from ~500 words in adversarial tasks up through 50K+
tokens in realistic ones). G2's "compaction loses" result is honest but was never a fair test of
compaction's actual selling point — CARL needs a correctness-under-length test (repeat G2's recall
question at, e.g., 80% of context window with plausible distractors planted, not just 5 clean facts) to
know whether resume's cost advantage survives past the point where quality — not cost — becomes the
active constraint.

---

## Bonus finding: extraction-style summaries lose fidelity vs. raw history

Not one of the five requested topics, but directly bears on G2's own flagged risk ("if the fresh-session
answer is wrong, the extraction is losing load-bearing state"): **["Verbatim Chunks Beat Extracted
Artifacts" (arXiv:2601.00821)](https://arxiv.org/abs/2601.00821)** ran a controlled ablation — same
retrieval/rerank/reasoning pipeline, only the stored representation changed (LLM-extracted structured
facts vs. raw verbatim chunks). Verbatim chunks won by **15.9 points on LoCoMo** (43.9% vs 28.0%) and
**22.0 points on LongMemEval-S** (67.4% vs 45.4%). Their conclusion: *"structured memory should augment
verbatim text rather than replace it."* G2's compaction artifact was a hand-built 235-char JSON extraction
(facts + `pending: none`) — exactly the representation this paper shows underperforms. It got the right
answer at G2's small scale, but the paper's result says don't scale that pattern up as-is; keep a
verbatim/chunk fallback alongside any extracted summary rather than replacing history with facts-only
JSON.

---

## Ranked top-3 actionable changes to CARL's compaction design

1. **Redesign compaction to fork the cached prefix, not open a cold session.** Match Claude Code's own
   `/compact` mechanism exactly: same system prompt + tool schema (same session lineage or a
   byte-identical prefix under a different session_id), append the summarization instruction as a
   message, let the conversation layer alone reset. This directly targets the fixed cold-start cost G2's
   RESULTS doc already identified as the likely cause of the 4.63x loss — re-run G2 sub-test 3 with this
   design before concluding compaction is cost-inferior at any scale.

2. **Trigger compaction off context-window-fraction, not turn count**, matching both MemGPT's
   70%-warn/100%-flush state machine and Claude Code's ~60%-manual/~95%-auto convention. "12 turns" and
   "50 turns" are not portable thresholds — different tasks produce wildly different tokens/turn. Report
   compaction decisions in `% of active model's context window` so the same policy travels across Haiku
   (200K) and any future higher-context model without re-tuning.

3. **Test compaction's real justification — correctness under length — not cost.** Re-run G2 at a scale
   where the cited literature (Liu et al. 2023, Chroma 2025) predicts actual degradation: push a session
   toward 50-80% of the model's context window with planted distractors (not just 5 clean facts among
   neutral padding), and compare resume vs. compact on **answer correctness**, not `total_cost_usd`. If
   compaction only wins on correctness (not cost) even after fix #1, that is a legitimate and sufficient
   justification per Anthropic's own stated rationale (§1) — CARL should not need a cost win to justify
   compacting; it needs a quality win, measured directly, which G2 has not yet done.
