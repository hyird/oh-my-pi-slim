# OMP (`@hyird/oh-my-pi-slim`)

OMP is a lightweight Pi-native agent orchestration extension inspired by the [upstream project](https://github.com/alvinunreal/oh-my-opencode-slim). It offers an Orchestrator or Council main-agent prompt, five specialist roles, parallel delegation, three-perspective Council review, and per-role child model and thinking settings. It is not an OpenCode plugin or a drop-in implementation of upstream features.

## Install and configure

Install from GitHub:

```sh
pi install git:github.com/hyird/oh-my-pi-slim
```

Restart Pi or run `/reload`. Run `/omp` **without arguments** to open settings; there are no `/omp` subcommands. Select the default main role (`pi`, `orchestrator`, or `council`). Settings list the main role first, then Oracle, Librarian, Explorer, Designer, and Fixer. Each specialist has one settings row: choose its model, then its thinking level, then its speed for OpenAI models; all choices save together. The model picker follows Pi's enabled model scope (`/scoped-models`); disabled models cannot be selected or launched as configured specialist overrides. Council reviewers always inherit the main session's model and thinking level, so Council has no child settings row. Explorer, Librarian, Oracle, Designer, and Fixer cannot be main roles. Choose “Inherit” in either picker to use the current Pi session's model or thinking level. Thinking choices are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; Pi clamps unsupported levels to the selected model's capabilities. Arrow keys navigate, Enter selects/saves, typing searches available models, and Esc goes back or closes settings. RPC mode uses equivalent selection dialogs. Invalid `omp.json` settings are reported; edit the file to correct them.

Pi controls the main session model and thinking level. OMP's specialist model and thinking settings affect only children; unset overrides inherit the delegating Pi session's values. Choosing `pi` keeps Pi's native main prompt and disables OMP delegation tools, so no OMP child agents are called. Choosing `orchestrator` or `council` adds the corresponding role prompt without restricting main-session tools. Council runs three separate reviews using the main session's model and thinking level; these are different perspectives, **not** cross-model consensus. The main model synthesizes their results. Council model or thinking overrides in `omp.json` are invalid.

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

## Specialist speed (OpenAI Fast mode)

Run `/omp`, select a specialist, choose its model (including Luna) and thinking level, then choose **Standard** or **Fast**. The speed picker is available for `openai` and `openai-codex` providers. Standard is the default, including for older configurations without a speed setting, and requests `service_tier: "default"`; Fast requests `service_tier: "priority"`. Speed is saved per specialist and affects only that specialist's child requests. It does not change the main session or Council. Choosing another provider clears the speed override when you save; overrides for other providers are ignored at launch.

For example, merge the following field into `omp.json` to request Fast for Explorer and Librarian:

```json
{
  "serviceTier": {
    "explorer": "priority",
    "librarian": "priority"
  }
}
```

Fast is a request preference, not a guaranteed latency. Model/account support and the actual tier are determined by the provider; OMP does not retry rejected Fast requests as Standard. OpenAI documents `priority` and `fast` as equivalent for supported models. Fast API processing costs more (GPT-6 Luna lists 2× Standard rates); Codex subscription access and quota behavior are determined separately by its backend. See [OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode) and [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).

## MCP mapping

With pi-mcp-adapter, Orchestrator can use verified non-context7 namespace proxies or the `mcp` gateway with an explicit server (for example `mcp({server:'gh_grep',tool:'search',args:{query:'repo'}})`). Unscoped gateway search, scripts, context7, and unattributed direct MCP tools are blocked; Council gets no MCP tools. Librarian children use an exclusive allowlist of public context7 and gh_grep namespace proxies; other specialists get none. Native `pi` retains its MCP tools. If the adapter exposes only direct tools, Orchestrator must use the scoped gateway instead. This is a tool-level policy, **not a network sandbox**: shell commands can still access the network. See [MCP boundaries](docs/references.md#mcp-defaults-mapping-pi-mcp-adapter-2370).

## Delegation and conversations

Running OMP task rows share one animation timer across batches, using the same spinner frames and cadence as Pi's Working indicator. Progress updates are coalesced, and unchanged animation frames reuse the existing widget and detail components. The timer stops when no active batch remains. Each dispatch resolves one configuration/model snapshot; later settings changes apply to later batches.

From the start of delegation, the interactive task card appears only above Pi's editor, with Pi's normal tool-card background and padding. Its initial height follows the number of dispatched tasks; it is never first drawn in the conversation. Click its task rows to read tasks and assistant replies. After completion, it stays fixed until the next user message; then it returns to the conversation. Automatic specialist completion messages do not move it.

Pi's `/reload`, switching sessions, and quitting Pi cancel active OMP children. Start any interrupted task again after reload; child processes are not resumed.

The main model decides whether to use `omp_delegate` (one specialist task or a non-empty array of tasks) or `omp_council` (three review perspectives). Both tools start background work immediately. Independent children start concurrently across calls, without a fixed count limit. The main model can continue independent work, then receives an automatic completion message. There is no separate task status/result tool. Switching sessions or shutting down cancels active work. A prompt cannot guarantee delegation on every turn. Orchestrator favors direct work for one isolated small change, Fixer for bounded multi-file work, Designer for UI/UX, Explorer for unfamiliar code, Librarian for research, and Oracle/Council for consequential decisions. Children run in isolated Pi JSON-mode subprocess contexts, with role tool allowlists. JSON children skip theme and prompt-template discovery while retaining skills and personal/provider extensions. When pi-mcp-adapter is detected, non-Librarian children receive an empty exclusive MCP configuration so unrelated servers do not initialize; Librarian keeps its two public servers. A child with `bash` is **not** sandboxed. Project trust is inherited, not automatically granted.

Completion is delivered at Pi's next safe tool boundary while the main agent is active, or starts a new turn when idle. The main agent should finish its current turn when no independent work remains; it should not call `sleep` or poll for results. The fixed card continues to show progress while work runs. Cancelling a batch marks every unfinished task as cancelled in the card and retains completed results when a completion message is delivered.

The task card shows each task's status from queued through completion. Hovering highlights the task row; click anywhere across that row to expand or collapse its full task text and the assistant replies recorded so far. Each dispatch keeps its own card, and only one task can be expanded at a time across cards. A finished batch returns to the conversation when the next OMP dispatch starts or the user sends a new message; unfinished batches stay fixed. In the fixed area, the detail opens directly below its task row and scrolls within its own height; later task rows remain in the card. Long task lists scroll separately. The visible line range and each specialist's measured output token/s appear beside its task name when they fit. The `OMP:orchestrator` status shows the main agent's separate token/s. Both rates use reported output tokens divided by model generation time; tool execution time is excluded. The fixed area uses at most half the terminal height; use the mouse wheel over long content. Tool calls, tool results, and thinking are not shown in the card. There is no Ctrl+Alt+O popup. OMP does not integrate with `pi-subagents`; that third-party package is neither installed nor required. Child runs are isolated local processes, not Pi native session persistence, named session continuation, or resumable child sessions.

Recordings are persisted under `getAgentDir()/omp/conversations` (normally `~/.pi/agent/omp/conversations`) as local JSON event logs. Older recordings remain on disk. They can contain sensitive prompts, code, full tool arguments/results, and emitted thinking. Protect this directory, avoid sharing it, and delete old logs yourself when no longer needed: OMP does not automatically expire or purge them. Live task cards maintain a bounded assistant-only preview incrementally instead of rereading full recordings on every update. Model-facing tool output is separately bounded/truncated; local logs retain the full recorded child-visible event data. Provider output may vary, and un-emitted content cannot be displayed.

Log events are batched for up to 100 ms or 64 KiB and flushed when a child completes, fails, or is cancelled. A hard process termination can lose the last buffered events. Write failures stop the affected child and report a recording failure. Task cards update directly from live events, without waiting for disk writes. Animation and fixed-card updates traverse only running or pinned batches; finished history remains available through direct lookups. Progress snapshots reuse unchanged rows and activity lists.

With an updated `pi-better-usage`, OMP children (`PI_OMP_CHILD=1`) skip quota widgets, account-service requests, and refresh timers; the parent session continues tracking usage.

The plugin UI and status/progress labels remain in **English**. The main agent is instructed to write delegated tasks and Council questions in the language of the latest user message. OMP passes those tasks through unchanged and appends reply-language guidance to the child role prompts using the most recent user text on the current session branch as a reference. If no user text is available, children are instructed to use the task language. Role prompts and Council perspective headings are not translated. There is no extra model call or translation cost before dispatch. Children are instructed to answer in the current conversation language; providers may still respond differently.

See [references and boundaries](docs/references.md) for read-only upstream comparisons. Remove the GitHub installation with `pi remove git:github.com/hyird/oh-my-pi-slim`. Licensed under [MIT](LICENSE), retaining upstream attribution.
