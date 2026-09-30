# OMP (`@hyird/oh-my-pi-slim`)

OMP is a lightweight Pi-native agent orchestration extension inspired by the [upstream project](https://github.com/alvinunreal/oh-my-opencode-slim). It offers an Orchestrator or Council main-agent prompt, five specialist roles, parallel delegation, three-perspective Council review, and per-role child model and thinking settings. It is not an OpenCode plugin or a drop-in implementation of upstream features.

## Install and configure

Install from GitHub:

```sh
pi install git:github.com/hyird/oh-my-pi-slim
```

Requires Pi 0.99.0 or newer. Restart Pi or run `/reload`. Run `/omp` **without arguments** to open settings; there are no `/omp` subcommands. Select the default main role (`pi`, `orchestrator`, or `council`). Settings list the main role first, then Oracle, Librarian, Explorer, Designer, and Fixer. Each specialist has one settings row: choose its model, then its thinking level; both choices save together. The model picker follows Pi's enabled model scope (`/scoped-models`); disabled models cannot be selected or launched as configured specialist overrides. Council reviewers always inherit the main session's model and thinking level, so Council has no child settings row. Explorer, Librarian, Oracle, Designer, and Fixer cannot be main roles. Choose “Inherit” in either picker to use the current Pi session's model or thinking level. Thinking choices are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; Pi clamps unsupported levels to the selected model's capabilities. Arrow keys navigate, Enter selects/saves, typing searches available models, and Esc goes back or closes settings. RPC mode uses equivalent selection dialogs. Invalid `omp.json` settings are reported; edit the file to correct them.

Pi controls the main session model and thinking level. OMP's specialist model and thinking settings affect only children; unset overrides inherit the delegating Pi session's values. Choosing `pi` keeps Pi's native main prompt and disables OMP delegation tools, so no OMP child agents are called. Choosing `orchestrator` or `council` adds the corresponding role prompt without restricting main-session tools. Council runs three separate reviews using the main session's model and thinking level; these are different perspectives, **not** cross-model consensus. The main model synthesizes their results. `orchestrator` and `council` model or thinking overrides in `omp.json` are invalid.

On a new install without `omp.json`, OMP uses these specialist defaults (the `openai-codex` provider name is Pi's Codex model provider):

| Role | Model | Thinking | Skills | MCP servers |
| --- | --- | --- | --- | --- |
| Oracle | `openai-codex/gpt-6-astra` | `high` | bundled `simplify` | none |
| Librarian | `openai-codex/gpt-6-luna` | `low` | none | `context7`, `gh_grep` |
| Explorer | `openai-codex/gpt-6-luna` | `low` | none | none |
| Designer | `openai-codex/gpt-6-luna` | `medium` | none | none |
| Fixer | `openai-codex/gpt-6-luna` | `high` | none | none |

The default main role is Orchestrator. For an Orchestrator default of `openai-codex/gpt-6-sol` with `high` thinking, set Pi's native `defaultProvider`, `defaultModel`, and `defaultThinkingLevel` settings. Orchestrator keeps Pi's available skills and OMP permits verified MCP servers except `context7`. Existing `omp.json` files retain their saved role choices; an explicit empty `models` or `thinking` object means those roles inherit the Pi session. If a factory model is not enabled or available, OMP's normal model reconciliation selects an enabled fallback and warns.

Settings live in `getAgentDir()/omp.json` (normally `~/.pi/agent/omp.json`, or under `PI_CODING_AGENT_DIR`). They do not change Pi authentication or the main model. For example:

```json
{
  "defaultAgent": "orchestrator",
  "models": {
    "explorer": "openai-codex/gpt-5.3-codex-spark",
    "oracle": "openai-codex/gpt-5.5"
  },
  "thinking": {
    "explorer": "low",
    "oracle": "high"
  }
}
```

If a previously saved specialist model is later disabled, OMP switches it to the current Pi model when that model is enabled, otherwise to the first available enabled model, and shows a notification. This happens when a session starts, `/omp` opens, or delegation runs. If no enabled model is available, `/omp` marks the role and delegation stops before child work.

OMP has no speed setting and does not override provider service tiers. Legacy `serviceTier` fields in `omp.json` are ignored and omitted the next time settings change. Model and thinking choices remain unchanged.

## Web search (Exa)

OMP provides the `websearch` tool in the main session (including native `pi`) and every specialist/Council child, matching upstream omo-slim's Exa-backed built-in web search. It calls `https://mcp.exa.ai/mcp` directly, without installing another MCP server or requiring an API key by default. Optionally set `EXA_API_KEY` to use your own Exa key. Hosted availability and rate limits are controlled by Exa.

Use `websearch({query: "latest Pi release documentation"})` for current web information. Optional arguments are `numResults` (default 8), `livecrawl` (`fallback` or `preferred`), `type` (`auto`, `fast`, or `deep`), and `contextMaxCharacters` (default 10000). These are search options, not model Fast mode or service-tier settings. Results include source content/URLs for citation; Librarian prefers official documentation and uses context7/gh_grep for library and repository research.

Searches run only when the tool is called, have a 25-second deadline, honor cancellation, and bound responses/output. Failures are reported rather than silently retried. Queries are sent to Exa and may cause public-page crawling; do not include secrets, private code, or personal data. Exa web search does not change the MCP allowlists below. OMP currently uses Exa only, not upstream's optional Parallel provider.

## MCP mapping

With pi-mcp-adapter, Orchestrator can use verified non-context7 namespace proxies or the `mcp` gateway with an explicit server (for example `mcp({server:'gh_grep',tool:'search',args:{query:'repo'}})`). Unscoped gateway search, scripts, context7, and unattributed direct MCP tools are blocked; Council gets no MCP tools. Librarian children use an exclusive allowlist of public context7 and gh_grep namespace proxies; other specialists get none. Native `pi` retains its MCP tools. If the adapter exposes only direct tools, Orchestrator must use the scoped gateway instead. This is a tool-level policy, **not a network sandbox**: shell commands can still access the network. See [MCP boundaries](docs/references.md#mcp-defaults-mapping-pi-mcp-adapter-2370).

## Delegation and conversations

Running OMP task rows share one animation timer across batches, using the same spinner frames and cadence as Pi's Working indicator. Progress updates are coalesced, and unchanged animation frames reuse the existing widget and detail components. The timer stops when no active batch remains. Each dispatch resolves one configuration/model snapshot; later settings changes apply to later batches.

From the start of delegation, the interactive OMP task overview appears only above Pi's editor, with Pi's normal tool-card background and padding. It has one heading and one row per current task, ordered by dispatch start even when a later dispatch starts running first. Its height follows the total number of fixed tasks; it is never first drawn in the conversation. Click a task row to read its task and assistant replies. After completion, it stays fixed until the next user message; then its original tool card returns to the conversation. Automatic specialist completion messages do not move it.

Pi's `/reload`, switching sessions, and quitting Pi cancel active OMP children and close idle workers. The task-ID registry belongs to the current parent session and is cleared on these boundaries; tasks are never resumed automatically. Native session files remain on disk for inspection.

The main model decides whether to use `omp_delegate` (one specialist task or a non-empty array of tasks) or `omp_council` (three review perspectives). Both tools start background work immediately. Independent children start concurrently across calls, without a fixed count limit. The main model can continue independent work, then receives an automatic completion message. There is no separate task status/result tool. Switching sessions or shutting down cancels active work. A prompt cannot guarantee delegation on every turn. Orchestrator favors direct work for one isolated small change, Fixer for bounded multi-file work, Designer for UI/UX, Explorer for unfamiliar code, Librarian for research, and Oracle/Council for consequential decisions. Children run in isolated Pi RPC subprocess contexts, with role tool allowlists. All children skip theme and prompt-template discovery. Explorer, Librarian, Designer and Fixer load no skills; Oracle loads only the bundled `simplify` skill. Tasks may still name a skill file to read explicitly. Council reviewers inherit the main session's skills, and all roles retain personal/provider extensions. The child-only OMP entry registers only `websearch`, without provider tier hooks or importing the scheduler, settings UI or renderers. When pi-mcp-adapter is detected, non-Librarian children receive an empty exclusive MCP configuration so unrelated servers do not initialize; Librarian keeps its two public servers. A child with `bash` is **not** sandboxed. Project trust is inherited, not automatically granted.

Each ordinary specialist result is delivered as soon as that task settles, without waiting for slower siblings. Adjacent completions coalesce for up to 50 ms; the last result flushes immediately. Notifications include completed and outstanding task counts and are delivered at Pi's next safe tool boundary while the main agent is active, or start a new turn when idle. Council delivers one combined result after all three reviewers settle. Failed notification delivery keeps retrying while the session is active, without rerunning child work or delaying other completed tasks; after six failures OMP warns once and backs off to at most 30 seconds between attempts. The main agent should finish its current turn when no independent work remains; it should not call `sleep` or poll for results. OMP then holds Pi's awaited turn-end boundary locally until the first result is successfully queued. This prevents automatic goal continuations from repeatedly requesting the model just to report that work is pending. User input, cancellation, session changes, and shutdown release the wait; failed or aborted model turns remain eligible for native recovery. The fixed card continues to show progress while work runs. Cancelling a batch marks every unfinished task as cancelled in the card and retains completed results when a completion message is delivered.

The task overview shows each task's status from queued through completion. Running rows also show an OMP-generated phase such as model work, tool execution, or a model-request retry. After a minute without a child event, the row shows the elapsed quiet time; this is diagnostic, not an automatic timeout. Provider errors, task activity text, and tool arguments are not used as row labels. Hovering highlights the task row; click anywhere across that row to expand or collapse its full task text and the assistant replies recorded so far. Only one task can be expanded at a time across dispatches. A finished batch returns to the conversation when the next OMP dispatch starts or the user sends a new message; unfinished batches stay fixed in the combined overview. In the fixed area, the detail opens directly below its task row and scrolls within its own height; earlier rows stay above it and later rows stay below it. Long task lists scroll separately. Each task row also shows the current run's elapsed time and reported total tokens (including cache tokens); completed, failed and cancelled runs retain their final values. The visible line range and each specialist's measured output token/s appear beside its task name when they fit. The `OMP:orchestrator` status shows the main agent's separate token/s. Both rates use reported output tokens divided by model generation time; tool execution time is excluded. The fixed area uses at most half the terminal height; use the mouse wheel over long content. Expanded details show the last 32 tool calls in order, including complete shell commands, read/edit file paths, and +added/-removed line counts for successful edits. Each tool row occupies one line with an ellipsis when needed; click it to wrap the full command or path inside the card. Tool result bodies (including file contents and diffs), edit replacement text, and thinking are not shown. There is no Ctrl+Alt+O popup. OMP does not integrate with `pi-subagents`; that third-party package is neither installed nor required. Child runs use isolated local processes and Pi-native session persistence. Task IDs support explicit continuation within the current parent session; OMP does not restore its task registry across reloads or parent-session changes.

Recordings are persisted under `getAgentDir()/omp/conversations` (normally `~/.pi/agent/omp/conversations`) as local JSON event logs. Older recordings remain on disk. They can contain sensitive prompts, code, full tool arguments/results, and emitted thinking. Protect this directory, avoid sharing it, and delete old logs yourself when no longer needed: OMP does not automatically expire or purge them. Live task cards maintain a bounded assistant-only preview incrementally instead of rereading full recordings on every update. Model-facing tool output is separately bounded/truncated; local logs retain the full recorded child-visible event data. Provider output may vary, and un-emitted content cannot be displayed.

Log events are batched for up to 100 ms or 64 KiB and flushed when a child completes, fails, or is cancelled. On normal parent Pi process exit, OMP synchronously flushes active recordings with a failed completion marker. A hard termination such as SIGKILL can still leave an incomplete recording or lose the last buffered events. Write failures stop the affected child and report a recording failure. Task cards update directly from live events, without waiting for disk writes. Animation and fixed-card updates traverse only running or pinned batches; finished history remains available through direct lookups. Progress snapshots reuse unchanged rows and activity lists.

With an updated `pi-better-usage`, OMP children (`PI_OMP_CHILD=1`) skip quota widgets, account-service requests, and refresh timers; the parent session continues tracking usage.

The plugin UI and status/progress labels remain in **English**. The main agent is instructed to write delegated tasks and Council questions in the language of the latest user message. OMP preserves each task and sends reply-language guidance alongside it using the most recent user text on the current session branch as a reference. Role system prompts stay stable across continuations; each continuation gets the current language guidance. If no user text is available, children are instructed to use the task language. Role prompts and Council perspective headings are not translated. There is no extra model call or translation cost before dispatch. Children are instructed to answer in the current conversation language; providers may still respond differently.

## Continue a specialist task

`omp_delegate` returns a `taskId` for each task. The main model can continue the same completed objective by supplying that ID with its role and a new instruction:

```ts
omp_delegate({ agent: "fixer", taskId: "<returned-task-id>", task: "Handle the empty-input case and run the focused checks." })
```

The same optional `taskId` is available on each item in `tasks`. Running, duplicate, unknown, wrong-role and changed-directory/trust continuations are rejected. Failed or cancelled tasks require inspection of partial work before an explicit continuation; OMP never restarts an entire specialist task automatically. Pi can retry transient model-request failures within that task, as described below. Unrelated objectives get new IDs and isolated contexts.

Up to four idle specialist processes stay available for two minutes. A continuation reuses the live runtime; after idle expiry or eviction it restores the task's Pi-native session from `getAgentDir()/omp/sessions/<taskId>/`. Model, thinking, MCP profile, role prompt, authentication/settings, and selected project instruction file changes rebuild the worker before continuing. Account label and email changes leave a warm worker running; credential changes rebuild it. Reload Pi after changing extension code. Council workers close after their single review. These native sessions, like conversation logs, can contain sensitive data and are retained until manually removed.

Completion requires Pi's `agent_settled` event and a subsequent idle-state check, followed by a successful recording flush. An intermediate assistant message, a pending retry, or an unexpected process exit is not successful completion. Results do not wait for idle process teardown. If state stays busy for five minutes after settlement, OMP fails the task and closes the worker. Cancellation asks Pi to abort and persist partial work before shutdown; an unresponsive process is terminated after a bounded grace period. Interactive extension prompts fail the child with an actionable error instead of being auto-approved or left waiting indefinitely.

Child sessions inherit Pi's model-request retry settings. Pi 0.99.0 enables retries for eligible transient errors by default, with up to three retries starting at a two-second delay. The task card shows Pi's retry attempt and delay without displaying the provider's error text or keeping failed-attempt drafts in its reply preview. A request that still fails after a retry is identified in the returned result; a cancelled retry is labeled separately. The private conversation recording retains the complete event history. OMP does not restart an entire specialist task after Pi reports a final failure. A final output-limit (`length`) stop is reported as incomplete, even when it contains text; use its `taskId` for an explicit continuation after inspecting partial work.

Delegated tasks should name file ownership, a verification owner and acceptance criteria. Specialists report changed paths, exact check commands and results, and remaining risks. The parent reuses still-valid evidence and reruns checks only when subsequent edits, integration risk or explicit requirements warrant it.

Per-run completion records include `taskId`, `runId`, startup time, time to the first model update, model-generation time, summed tool time and total run time. In-memory result details also track ordinary-task notification latency, including delivery retries. Overlapping tool durations can sum to more than wall time. Measurements describe local execution; no provider latency or speed-up percentage is assumed.

See [references and boundaries](docs/references.md) for read-only upstream comparisons. Remove the GitHub installation with `pi remove git:github.com/hyird/oh-my-pi-slim`. Licensed under [MIT](LICENSE), retaining upstream attribution.

## Development

Runtime modules live in `extensions/omp/`; `entry.ts` is the Pi entry point. Run `bun install --frozen-lockfile` and `bun run check` for type checking and tests. Use `bun run typecheck` or `bun test` for focused checks.

Use kebab-case file names and keep tests in `tests/` as `<module>.test.ts`. Name cross-module tests `<feature>-integration.test.ts` and put executable test fixtures in `tests/fixtures/`. Keep regressions in the owning test suite; avoid separate files for a single check. Use Bun and commit only `bun.lock` for dependency resolution.
