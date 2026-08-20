# How open-source agent frameworks actually detect "stuck" / looping — real code, not docs

Research question for CENTRAL/CARL: our supervisor currently uses an LLM-judge (local Ollama model reads a
compacted event stream, outputs continue/stop). Is there a more measurable/objective signal that established
frameworks use instead of, or alongside, self-report/judgment?

Method: cloned each repo (or used `gh search code` / raw GitHub fetch where cloning wasn't needed) and read the
actual detector/limiter source, not the marketing docs. All line numbers and snippets below are copy-pasted from
the real files as of 2026-08-19/20.

**Headline finding: every framework that has a real detector implements it as deterministic equality/counting
over structured events — never an LLM call. Two frameworks (LangGraph, and CrewAI's core loop) don't attempt
semantic loop detection at all; they only cap the number of iterations. Only AutoGPT (classic) and OpenHands
have anything that inspects *content* to decide "this is a repeat," and both do it with plain equality checks,
not a judge model.**

| Framework | Real detector in code? | Category |
|---|---|---|
| AutoGPT (classic `forge`) | Yes — `WatchdogComponent` | **Measurable** (exact repeat of tool name + args, 1-step lookback) |
| AutoGPT (new `autogpt_platform`) | No | Hard iteration cap only, no repeat check |
| LangGraph | Yes — `recursion_limit` / `GraphRecursionError` | **Measurable, but naive**: pure step-count cap, no state/cycle awareness |
| AutoGen (current `autogen-agentchat`, v0.4+) | Yes — `TerminationCondition` family | **Measurable**: composable counters (message count, tokens, timeout, text match) — no built-in repetition detector |
| OpenHands (V1 `software-agent-sdk`) | Yes — `StuckDetector` | **Measurable**: 5 heuristics, all structural-equality/counting, zero LLM calls in the detection path |
| SWE-agent | Partial — per-failure-mode counters, no general detector | **Measurable** but narrow: consecutive-timeout counter, requery counter, exact-duplicate-completion check |
| CrewAI | Partial — `max_iter` hard cap; separate planner deadlock check | **Measurable**: iteration counter (core loop) + structural dependency-deadlock check (experimental planner) — no repeated-action detector |

---

## 1. AutoGPT — `Significant-Gravitas/AutoGPT`

Two live codebases in this monorepo behave differently, and the answer depends on which one you mean:

### 1a. Classic agent framework (`classic/forge`) — has a real, measurable detector

`classic/forge/forge/components/watchdog/watchdog.py` — `WatchdogComponent`, wired into the main agent as
`self.watchdog = WatchdogComponent(settings.config, settings.history).run_after(ContextComponent)` in
`classic/original_autogpt/autogpt/agents/agent.py:214`.

Full source (as fetched from `raw.githubusercontent.com/.../classic/forge/forge/components/watchdog/watchdog.py`):

```python
class WatchdogComponent(AfterParse[AnyProposal]):
    """
    Adds a watchdog feature to an agent class. Whenever the agent starts
    looping, the watchdog will switch from the FAST_LLM to the SMART_LLM and re-think.
    """

    def after_parse(self, result: AnyProposal) -> None:
        ...
        previous_command, previous_command_args = None, None
        if len(self.event_history) > 1:
            previous_cycle = self.event_history.episodes[self.event_history.cursor - 1]
            previous_command = previous_cycle.action.use_tool.name
            previous_command_args = previous_cycle.action.use_tool.arguments

        rethink_reason = ""
        if not result.use_tool:
            rethink_reason = "AI did not specify a command"
        elif (
            result.use_tool.name == previous_command
            and result.use_tool.arguments == previous_command_args
        ):
            rethink_reason = f"Repititive command detected ({result.use_tool.name})"

        if rethink_reason:
            logger.info(f"{rethink_reason}, re-thinking with SMART_LLM...")
            self.event_history.rewind()
            self.big_brain = True
            self.revert_big_brain = True
            raise ComponentSystemError(rethink_reason, self)
```

**Mechanism**: exact equality (`==`) of the proposed tool name and arguments against the *immediately preceding*
cycle only (1-step lookback, not a hash of a longer window). No LLM is consulted to decide "is this a loop" — a
plain Python `==` comparison does it. What happens on detection is notable: it doesn't stop the agent, it
escalates — swaps `FAST_LLM` → `SMART_LLM` for one re-think, then reverts. Documented in
`docs/content/forge/components/built-in-components.md`: *"Watches if agent is looping and switches to smart mode
if necessary."* Also indexed in `classic/forge/CLAUDE.md:57,273` as `WatchdogComponent | AfterParse | Loop
detection, LLM switching`.

Category: **Measurable, not self-report.** Weakness: only a 1-cycle lookback, so it catches immediate A-A-A
repetition but not a 2- or 3-step cycle (A→B→A→B), and it fires on args equality, not on a broader "no forward
progress" signal.

URLs:
- https://github.com/Significant-Gravitas/AutoGPT/blob/master/classic/forge/forge/components/watchdog/watchdog.py
- https://github.com/Significant-Gravitas/AutoGPT/blob/master/classic/original_autogpt/autogpt/agents/agent.py#L214
- https://github.com/Significant-Gravitas/AutoGPT/blob/master/docs/content/forge/components/built-in-components.md

### 1b. New block-based platform (`autogpt_platform`) — no repetition detection, just a hard cap

`autogpt_platform/backend/backend/util/tool_call_loop.py` — the shared tool-calling loop used by the
OrchestratorBlock and copilot baseline. Its own docstring: *"5. Repeats until no more tool calls or max
iterations reached"* (line 10). The loop condition is `while max_iterations < 0 or iteration < max_iterations:`
(line 203) with `max_iterations: int = -1` meaning unlimited by default. No equality check against prior tool
calls exists anywhere in this file — confirmed by grep for `loop|max_iter|stuck|repeat` across the file.

Category: **No detector** — pure optional iteration cap, and the cap is disabled by default (-1). The classic
Watchdog's semantic check did not carry over into the platform rewrite.

URL: https://github.com/Significant-Gravitas/AutoGPT/blob/master/autogpt_platform/backend/backend/util/tool_call_loop.py

---

## 2. LangGraph — `langchain-ai/langgraph`

`recursion_limit` is a config key consumed by the Pregel execution loop. `libs/langgraph/langgraph/pregel/_loop.py`
sets a hard ceiling on the superstep counter:

```python
# _loop.py, appears twice (sync + async loop setup)
self.step = self.checkpoint_metadata["step"] + 1
self.stop = self.step + self.config["recursion_limit"] + 1
```

The actual raise happens in `libs/langgraph/langgraph/pregel/main.py:3011` (and again at `:3492` for the async
path), guarded purely on loop status, not on any inspection of what the graph actually did:

```python
if loop.status == "out_of_steps":
    msg = create_error_message(
        message=(
            f"Recursion limit of {config['recursion_limit']} reached "
            "without hitting a stop condition. You can increase the "
            "limit by setting the `recursion_limit` config key."
        ),
        error_code=ErrorCode.GRAPH_RECURSION_LIMIT,
    )
    raise GraphRecursionError(msg)
```

`GraphRecursionError` itself (`libs/langgraph/langgraph/errors.py:67`) is documented candidly: *"Raised when the
graph has exhausted the maximum number of steps. This prevents infinite loops."* — the docstring conflates "ran
out of steps" with "was looping," but the code has no way to distinguish a genuinely long, productive multi-step
task from an actual A→B→A→B cycle. It is a **step counter**, not a cycle detector: `loop.status` becomes
`"out_of_steps"` purely from a superstep tally (`self.step >= self.stop`) that increments on every graph tick
regardless of whether the same node/state is repeating.

I checked for anything smarter (state hashing, node-repeat tracking) and found none: `grep -rn "infinite loop"`
across the whole `libs/` tree returns only the errors.py docstring and two *test assertions* that check the hard
cap fires (`tests/test_pregel.py:7678,7843: assert False, "Detected infinite loop"` — these are testing that the
recursion_limit itself works, they are not evidence of a separate detector).

Category: **Measurable, but the crudest kind** — a monotonic counter with a ceiling, agnostic to content. It will
happily let a graph oscillate between two nodes 999 times before firing on the 1000th step, and will just as
happily kill a legitimately long-running productive graph that needed step 1001.

URLs:
- https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/pregel/_loop.py
- https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/pregel/main.py#L3011
- https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/errors.py#L67

---

## 3. AutoGen — `microsoft/autogen`

The repo has moved on from the classic `ConversableAgent` API (where `max_consecutive_auto_reply` lived) to the
v0.4+ `autogen-agentchat` package built around a composable `TerminationCondition` protocol. Grepping the current
tree for `consecutive_auto_reply` turns up **zero** hits in source — it only appears in
`python/docs/.../migration-guide.md` as the *old* parameter being migrated away from, replaced by
`MaxMessageTermination`.

`python/packages/autogen-agentchat/src/autogen_agentchat/conditions/_terminations.py` defines the built-in
conditions (class list, all in this one file, 614 lines):

```
StopMessageTermination        # stops on an explicit StopMessage
MaxMessageTermination         # hard message-count cap
TextMentionTermination        # stops when specific text appears
FunctionalTermination         # user-supplied predicate/callable (could wrap an LLM judge, but isn't one by default)
TokenUsageTermination         # hard token-count cap
HandoffTermination            # stops on agent handoff signal
TimeoutTermination            # wall-clock cap
ExternalTermination           # external signal (e.g. UI stop button)
SourceMatchTermination        # stops after a specific agent speaks
TextMessageTermination        # stops on a text message from a given source
FunctionCallTermination       # stops on a specific tool/function call
```

`MaxMessageTermination` (lines 62–98) is the direct spiritual successor to `max_consecutive_auto_reply`:

```python
class MaxMessageTermination(TerminationCondition, Component[MaxMessageTerminationConfig]):
    def __init__(self, max_messages: int, include_agent_event: bool = False) -> None:
        self._max_messages = max_messages
        self._message_count = 0
    @property
    def terminated(self) -> bool:
        return self._message_count >= self._max_messages
    async def __call__(self, messages): 
        self._message_count += len([m for m in messages if ...])
        if self._message_count >= self._max_messages:
            return StopMessage(...)
```

Pure counter, no content inspection. `FunctionalTermination` (lines 158–228) is the one place a user *could* wire
in an LLM-judge (`func` can be any sync/async callable over the message list) — but it ships empty; AutoGen
provides the hook, not the judge, and none of the built-ins use it internally.

**Nothing in this framework detects repeated/looping tool calls or content.** Every built-in condition is either
a hard counter (messages, tokens, time) or an exact string/source/type match. There is no analog to AutoGPT's or
OpenHands's "same action twice in a row" check anywhere in `autogen-agentchat`, `autogen-core`, or `autogen-ext`
(confirmed by `grep -rli "stuck"` across `python/packages/` returning no hits outside test/doc files, and no
`LoopDetect`/`repeated` class definitions anywhere in the source tree).

Category: **Measurable (counters only), no repetition/loop detector at all** — termination is purely
budget-based (turns/tokens/time) or trigger-based (text/source match), composed with boolean AND/OR by the
caller. The classic `max_consecutive_auto_reply` this superseded was, for the record, also just a raw counter of
consecutive automated replies without human input — never content-aware.

URLs:
- https://github.com/microsoft/autogen/blob/main/python/packages/autogen-agentchat/src/autogen_agentchat/conditions/_terminations.py
- https://github.com/microsoft/autogen/blob/main/python/docs/src/user-guide/agentchat-user-guide/migration-guide.md

---

## 4. OpenHands — `OpenHands/OpenHands` (V1 SDK: `OpenHands/software-agent-sdk`)

Note the repo's org was renamed from `All-Hands-AI` to `OpenHands`, and the agent runtime itself now lives in a
separate repo, `OpenHands/software-agent-sdk` (the main `OpenHands/OpenHands` repo is now the frontend/server
shell that just passes a `stuck_detection: bool` flag through to it). This is the most thorough, actively
maintained detector found in this survey.

`openhands-sdk/openhands/sdk/conversation/stuck_detector.py` — class `StuckDetector`, enabled by default
(`stuck_detection: bool = True` in `Conversation.__init__`, `openhands-sdk/.../conversation.py`). Full logic
(abridged, exact quotes below):

```python
MAX_EVENTS_TO_SCAN_FOR_STUCK_DETECTION: int = 20

class StuckDetector:
    """Detects when an agent is stuck in repetitive or unproductive patterns.
    1. Repeating action-observation cycles
    2. Repeating action-error cycles
    3. Agent monologue (repeated messages without user input)
    4. Repeating alternating action-observation patterns
    5. Context window errors indicating memory issues
    """
```

It scans only the events **since the last user message** (so it never flags a legitimately long agent turn as
"the same as last time the user talked"), then runs five checks in order, short-circuiting on the first hit:

- **Scenario 1 — action/observation loop** (`action_observation_threshold`, default `4`): the last N actions are
  all equal to each other *and* the last N observations are all equal to each other, via `_event_eq()` — a
  field-level equality that ignores IDs/timestamps/metrics but compares `tool_name`, `action`, `thought`
  (actions) or `observation`, `tool_name` (observations).
- **Scenario 2 — action/error loop** (`action_error_threshold`, default `3`): same action repeatedly followed by
  an `AgentErrorEvent`. Notably it **nudges before it stops** — `get_action_error_nudge()` fires a corrective
  message into the conversation exactly once when the streak first crosses the threshold ("You've called `X`
  with the same arguments 3 times in a row and gotten the same error each time... Repeating the exact same call
  again will not work"), and only escalates to a hard `STUCK` status if the streak continues past that (a
  streak > threshold, per `_is_stuck_repeating_action_error`). `tests/sdk/conversation/local/test_stuck_detector_nudge.py`
  names this explicitly: *"4 identical failing calls: nudge after the 3rd, hard STUCK after the 4th."*
- **Scenario 3 — monologue** (`monologue_threshold`, default `3`): N consecutive agent `MessageEvent`s with no
  intervening user message.
- **Scenario 4 — alternating A/B/A/B pattern** (`alternating_pattern_threshold`, default `6`): checks
  `last_actions[i] == last_actions[i+2]` for a period-2 cycle — this is the one thing in this whole survey that
  catches a 2-step oscillation, something AutoGPT's Watchdog (1-step lookback) and everything else here misses.
- **Scenario 5 — context-window error loop**: present in the state machine but currently stubbed
  (`return False`, with a `# TODO: blocked by ...#282` comment) — an honest "not implemented yet," not a fake
  pass.

All of `_event_eq()` is structural equality on Pydantic event fields — **zero LLM calls anywhere in `is_stuck()`
or its helpers.** Detection sets `ConversationExecutionStatus.STUCK` directly in
`openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py:724-726`:

```python
if self._stuck_detector.is_stuck():
    logger.warning("Stuck pattern detected.")
    self._state.execution_status = ConversationExecutionStatus.STUCK
    return True
```

Thresholds are user-overridable per conversation (`stuck_detection_thresholds` param, `StuckDetectionThresholds`
Pydantic model in `openhands-sdk/openhands/sdk/conversation/types.py`), and the whole thing can be disabled with
`stuck_detection=False`.

Category: **Measurable, not self-report — the most complete example found.** Multiple named heuristics, each a
plain equality/counting check over a bounded recent-event window, with a documented "nudge-then-stop" escalation
policy (give the agent one corrective hint before declaring it stuck) rather than an instant kill.

URLs:
- https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/stuck_detector.py
- https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/types.py
- https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py#L724
- https://github.com/OpenHands/software-agent-sdk/blob/main/tests/sdk/conversation/local/test_stuck_detector_nudge.py
- https://github.com/OpenHands/software-agent-sdk/blob/main/examples/01_standalone_sdk/20_stuck_detector.py

---

## 5. SWE-agent — `SWE-agent/SWE-agent`

No single general-purpose "stuck detector" class exists (confirmed: `grep -rli stuck --include=*.py .` across
the whole repo returns zero files). Instead, SWE-agent handles "the agent isn't making progress" as several
**separate, narrow, hard-counted failure modes**, each raising a distinct exit code:

`sweagent/agent/agents.py`:
```python
#: Count how many timeout errors have occurred consecutively. Kills agent
#: after 5 of them.
self._n_consecutive_timeouts = 0
...
except CommandTimeoutError:
    self._n_consecutive_timeouts += 1
    if self._n_consecutive_timeouts >= self.tools.config.max_consecutive_execution_timeouts:
        msg = "Exiting agent due to too many consecutive execution timeouts"
        ...
        raise
```
(`max_consecutive_execution_timeouts: int = 3` in `sweagent/tools/tools.py:150`, comment above says 5 but the
default field value is 3 — the docstring is stale relative to the field default, worth noting as its own small
finding.)

Separately, `max_requeries: int = 3` (`sweagent/agent/agents.py:451,472`) caps how many times the model gets
requeried after a parse/format/blocklist/bash-syntax error before the whole run exits with
`"Exit due to repeated format/blocklist/bash syntax errors"` (`agents.py:1212,1217`). Cost limits and context
limits are separate, similarly hard-counted, exit paths (`CostLimitExceededError`, `ContextWindowExceededError`).

The closest thing to a *content*-level repetition check is in the optional parallel action sampler,
`sweagent/agent/action_sampler.py` (only active if `action_sampler_config` is set — not the default path):

```python
def get_completions(self, history):
    completions = self._model.query(history, n=self.config.min_n_samples)
    completions = self.filter_parseable_completions(completions)
    completions = self.filter_duplicates(completions)   # dedups by string equality
    ...
    if len(completions) == 1:
        _, action = self._tools.parse_actions(completions[0])
        self._logger.warning("Only identical actions were proposed (action=%s)", action)
    return completions
```

This is a same-turn dedup of N parallel-sampled completions collapsing to one distinct action — a warning log,
not a stop condition, and it says nothing about repetition *across turns*.

Category: **Measurable, but fragmented and narrow.** SWE-agent hard-caps specific technical failure classes
(timeouts, parse errors, cost, context) with simple integer counters — the same pattern as LangGraph's
recursion_limit, just split into several typed counters instead of one generic step count. It has **no
equivalent of AutoGPT's or OpenHands's "the agent proposed the same successful action three times in a row"**
check — a agent that keeps calling the same (successfully-executing, non-erroring) `str_replace_editor view`
repeatedly with slightly different but functionally identical intent would not be caught by anything here.

URLs:
- https://github.com/SWE-agent/SWE-agent/blob/main/sweagent/agent/agents.py
- https://github.com/SWE-agent/SWE-agent/blob/main/sweagent/tools/tools.py#L150
- https://github.com/SWE-agent/SWE-agent/blob/main/sweagent/agent/action_sampler.py#L263

---

## 6. CrewAI — `crewAIInc/crewAI`

Monorepo, current layout `lib/crewai/src/crewai/...`. The core agent-execution loop
(`lib/crewai/src/crewai/agents/crew_agent_executor.py`, and its experimental successor
`lib/crewai/src/crewai/experimental/agent_executor.py`) uses a single hard iteration cap, checked on every loop
turn in four separate loop bodies in that file:

```python
while not isinstance(formatted_answer, AgentFinish):
    if has_reached_max_iterations(self.iterations, self.max_iter):
        formatted_answer = handle_max_iterations_exceeded(
            formatted_answer, printer=PRINTER, messages=self.messages,
            llm=cast("BaseLLM", self.llm), callbacks=self.callbacks, verbose=self.agent.verbose,
        )
        break
```

`has_reached_max_iterations` (`lib/crewai/src/crewai/utilities/agent_utils.py:363`) is a one-line integer
comparison. `handle_max_iterations_exceeded` (same file, line 376) does **not** detect a loop — it just forces
termination by making one more LLM call asking for a final answer ("Maximum iterations reached. Requesting final
answer."). No content/action equality check exists anywhere in the file — confirmed by grepping for
`stuck|repeated|identical` in `crew_agent_executor.py` with zero hits.

The one genuinely content-aware "stuck" concept in the codebase lives in the **experimental structured-planner**
path (`lib/crewai/src/crewai/experimental/agent_executor.py:1083-1094`), and it detects a *planning* deadlock,
not an LLM behavioral loop:

```python
ready = self.state.todos.get_ready_todos()
if not ready:
    if self.state.todos.is_complete:
        return "all_todos_complete"
    # Stuck state: pending todos exist but none are ready (unsatisfied
    # dependencies, e.g. a dependency was never completed). Trigger a
    # replan so the planner can generate a new plan that unblocks
    # execution rather than erroneously finalizing.
    self.state.last_replan_reason = (
        "No todos are ready but plan is not complete — "
        "likely a dependency deadlock or missing completion"
    )
    return "needs_replan"
```

This is a structural graph check (are there any todos whose dependencies are all satisfied?), measurable and
deterministic, but it answers a different question than "is the agent looping" — it answers "is the DAG of
planned subtasks deadlocked," and its remedy is an automatic replan, not a stop/escalate signal.

Category: **Measurable (iteration counter) for the core loop; no repeated-action detector anywhere in CrewAI.**
The only content-aware "stuck" check is a structural todo-dependency deadlock detector in the experimental
planner, unrelated to catching an agent that repeats the same tool call.

URLs:
- https://github.com/crewAIInc/crewAI/blob/main/lib/crewai/src/crewai/agents/crew_agent_executor.py
- https://github.com/crewAIInc/crewAI/blob/main/lib/crewai/src/crewai/utilities/agent_utils.py#L363
- https://github.com/crewAIInc/crewAI/blob/main/lib/crewai/src/crewai/experimental/agent_executor.py#L1083

---

## What this means for CARL

1. **No framework surveyed uses an LLM-judge as its primary stuck/loop detector.** Every real detector found is
   deterministic: equality comparisons on structured fields, or integer counters against a threshold. Where an
   LLM gets involved (AutoGPT's Watchdog escalating to SMART_LLM, CrewAI's forced-final-answer call, AutoGen's
   `FunctionalTermination` hook), it is invoked strictly *after* a measurable trigger has already fired — never
   as the trigger itself.

2. **OpenHands's `StuckDetector` is the closest existing prior art to what CARL should have alongside its
   Ollama judge**, and it's directly portable: it needs only a structured event log (action + observation +
   error + message, each typed and comparable) and five independent counting checks over a bounded recent
   window. It is open (MIT), small (~300 lines, single file, no dependencies beyond the SDK's own event types),
   and battle-tested against real coding-agent trajectories (that's literally what OpenHands runs).

3. **AutoGPT's Watchdog demonstrates the cheapest possible version**: a single `==` comparison between the
   current proposed tool-call and the immediately-previous one. Trivial to add as a first pass even before a
   full OpenHands-style detector, and it demonstrates the escalate-don't-just-kill pattern (retry once with a
   stronger model / a corrective nudge, and only hard-stop if the repeat continues).

4. **What nobody does, that CARL's Ollama-judge approach is trying to cover, is *semantic* progress
   detection** — recognizing that an agent is issuing superficially different but substantively unproductive
   actions (e.g., reading the same 5 files in a different order each time, or rephrasing the same failed plan).
   None of these six frameworks attempt that with a model; they only catch literal or near-literal repetition.
   That gap is real, but the fix used in the wild is not "replace the counters with a judge" — it's "layer a
   cheap, deterministic repeat-detector as the fast/reliable first line, and treat any LLM-based judgment as a
   slower, fallible second opinion that fires much less often and never gets full veto power alone."
