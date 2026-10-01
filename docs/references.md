# References and implementation boundaries

## Official Pi 0.99.2 contracts

- [Extensions](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/extensions.md): use public registration, lifecycle hooks, `ctx.executeTool()`, and `model-only` exposure for orchestration tools.
- [MCP](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/mcp.md) and [SDK](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/sdk.md#codemode-mcp): use Pi's native connector. Remove `pi-mcp-adapter` from loaded packages before using OMP children, since competing `/mcp` owners cause their isolation check to fail.
- [Providers](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/providers.md): new installations prefer `/login openai` with Sign in with ChatGPT; saved legacy credentials are not converted between grants.
- [Packages](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/packages.md#declare-dependencies): host-provided modules are wildcard peers and are not bundled; exact 0.99.2 development dependencies validate the implementation.

The extension loader regression uses the public SDK `DefaultResourceLoader`, including discovery from a temporary directory outside the checkout. The child connector receives an explicitly typed `ExtensionAPI` view that delegates registration to Pi and scopes its server list; this leaves the host API and registry unchanged. Gateway calls use the public `ctx.executeTool()` pipeline.

The upstream projects below are **read-only inspiration**, not runtime dependencies or promises of API compatibility with future releases. OMP has its own isolated Pi RPC child subprocess backend and its own local conversation recorder. No third-party `pi-subagents` installation or integration is required.

## [Upstream source](https://github.com/alvinunreal/oh-my-opencode-slim)

- `src/agents/orchestrator.ts`: routing is decided by the main model, not a keyword classifier. Direct work is reserved for an isolated low-risk step; bounded implementation goes to Fixer, UI/UX to Designer, exploration to Explorer, research to Librarian, and expensive decisions to Oracle/Council. Independent tasks can be delegated in parallel. OMP adopts this decision threshold, not upstream performance or cost claims.
- `src/agents/index.ts`: Orchestrator is a primary role, Council can be primary or delegated, and Explorer/Librarian/Oracle/Designer/Fixer are specialists. OMP adds `pi` as a native main-role choice.
- `src/index.ts` and `src/hooks/task-session-manager/`: OpenCode supplies its own task host and reusable child sessions. OMP provides background dispatch, concurrent children, fixed running task status, and automatic completion messages, and explicit task-ID continuation backed by Pi-native sessions. The task registry is local to the current parent session.

## [mjakl/pi-subagent](https://github.com/mjakl/pi-subagent) (3.0.3 reference)

- `index.ts`, `contract.ts`: a model-callable `subagent` tool plus discovery/selection instructions; the main model chooses whether to dispatch.
- `agents.ts`, `runner.ts`, `session-lock.ts`, `render.ts`: frontmatter agents, isolated RPC children, optional named continuation, locking, cancellation, result truncation, and streaming activity renderers. OMP uses its own isolated RPC executor and per-task recordings, with explicit task-ID continuation and a bounded idle-worker cache; it does not import that implementation.
- Its older Pi peer naming must not be assumed compatible with `@earendil-works/pi-coding-agent` without integration tests.

## [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)

- Its async completion notifier uses `pi.sendMessage` with `triggerTurn` and Pi's default steering delivery. OMP explicitly uses `deliverAs: "steer"` so a busy main agent receives completed work at the next safe boundary instead of waiting until its turn settles. OMP retains its own fixed task card and does not import the package.

## [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) (0.19.0 reference)

- `src/index.ts`, `src/ui/agent-widget.ts`, `src/ui/fleet-list.ts`, `README.md`: native subagent tools, background sessions, live widget, and session-backed conversation browsing. OMP uses its own fixed task card with rows that expand to show task text and assistant replies. It does not import this package or provide FleetView; its native-session continuation is implemented independently.
- `docs/rpc.md` documents an in-process RPC path that requires that package to be installed and active. OMP does **not** use it or install it. Model selection and result delivery on that path would require explicit design and testing before any future integration.

## Exa web search

Upstream omo-slim [`docs/mcps.md`](https://github.com/alvinunreal/oh-my-opencode-slim/blob/2ef5109baec0f8f08716995071d123880f8a3993/docs/mcps.md) now recommends OpenCode's Exa-backed built-in `websearch`, not a websearch MCP. OMP independently implements the same stateless hosted Exa `tools/call` (`web_search_exa`) used by OpenCode's [`mcp-websearch.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/mcp-websearch.ts). No OpenCode runtime, Exa SDK or additional MCP adapter is required for this tool.

`websearch` is available to the main session and all children, independently of MCP server permissions, as upstream websearch is a regular tool. It uses Exa without a key by default, with optional `EXA_API_KEY`; it does not implement Parallel routing or require OpenCode's environment flags. The default query options are 8 results, fallback live crawling, auto search and 10000 context characters. Response parsing accepts JSON and SSE; network requests have a 25-second deadline and caller cancellation, a 1 MiB wire limit and a 50000-character output limit. Errors do not disclose transport URLs, API keys or server diagnostics. Search queries are external data disclosures; this is not a privacy sandbox or a promise of free/unlimited Exa access. Tests use mock transports and do not call paid/live search services.

## Native MCP child isolation (Pi 0.99.2)

Librarian children use Pi's built-in MCP extension with an injected in-memory `loadConfig`: the server exposure defaults to `hidden`, wildcard tool exposure hides every server tool, and only upstream `searchGitHub` is `deferred`. The target is callable but not active; the child hard allowlist includes the gateway and exact nested target, `mcp__gh_grep__searchGitHub`. Pi 0.99's `AgentSession._getCallableTools` includes registered `deferred` tools even when inactive, and the offline SDK integration test verifies the exact target remains callable while absent from active tools. Only the gateway is declared to the model: its `prepareLoadout.hiddenDeclarations` removes MCP helpers/targets, and `tool_call` hooks reject direct calls while authorizing only the one-use, matching-argument nested call from the gateway. Pi 0.99.2 starts deferred server connections without blocking the first prompt. The gateway observes native target registration, waits at most 10 seconds when needed, and releases pending waits on cancellation, shutdown, or isolation failure. It validates target ownership and exposure again before calling through `ctx.executeTool`, preserving Pi validation, hooks and permission gates. Child prompts remove the native `mcp_servers` discovery section because its helpers are denied by the scoped policy. Offline SDK tests cover delayed registration, bounded unavailability, cancellation while connecting, concurrent calls, and denial of direct/unauthorized nested calls after registration. Other child roles get an empty MCP config. The connector reads no global or project `mcp.json` and sees no servers registered by other extensions; the host registry itself is unchanged. Context7, direct namespaces, `codemode`, `tool_search`, resources and `mcpScript` are denied. A legacy MCP extension that owns any `/mcp` or `/mcp:n` command causes startup to fail closed; there is no adapter fallback.

This is a Pi tool/configuration boundary, **not a network sandbox**: children retaining `bash` can still make network requests. The `--tools` hard allowlist includes `mcp` and the exact native target. Pi 0.99's MCP `deferred` exposure keeps the target out of the active/model-declared set while still callable through `ctx.executeTool`; the gateway hides MCP declarations and rejects direct calls.

Main-session OMP policy reads native MCP source metadata (`builtin:mcp`) and the host-provided namespace rather than guessing ownership from a potentially shortened name. Orchestrator allows non-context7 namespaces and explicitly scoped resources; Council denies MCP. The tool_call hook applies to nested codemode calls and tools activated later by tool_search. Legacy adapter tools retain their server-scoped policy. Switching back to native Pi restores only tools OMP suppressed. This policy is not an OS trust boundary.

## What OMP actually does

`/omp` opens settings only. The main model may call `omp_delegate` for one task or any non-empty task array, or `omp_council` for three perspectives. Independent child subprocesses run concurrently across calls without a fixed count limit. Progress and assistant replies appear only in the fixed task card from dispatch until the next user message after completion; then the card returns to the conversation. Ordinary results are automatically delivered per settled task; Council results are combined after all three reviews. Completed-task notifications coalesce briefly and carry outstanding-work counts. There is no separate status/result tool. Neither dispatch tool is automatically invoked by a keyword rule. Council perspectives inherit the main session's model and thinking level; they are separate runs, not different-model agreement. The main session remains responsible for verification and synthesis. Children have role tool allowlists, inherit project trust, and are not OS-sandboxed.

Inline cards show task names and status. Clicking one task row expands its task text and assistant replies from JSON event logs in `getAgentDir()/omp/conversations`; tool activity and thinking are not displayed. Model-facing replies are truncated independently of the recording. Older logs remain on disk and may hold sensitive data until manually removed. Those event recordings are separate from the Pi-native continuation files under `getAgentDir()/omp/sessions`. Both are retained on disk. OMP does not capture hidden provider thinking that was never emitted.

Plugin UI text is English. The main agent writes delegated tasks and Council questions in the latest user message's language. Tasks are passed through unchanged; each task message includes reply-language guidance with the latest user text as a reference, falling back to the task language when no user text is available. Role prompts and Council perspective headings remain unchanged. Dispatch makes no extra model call for language detection or translation. The provider can still answer in another language. Stronger automatic routing would require a separate policy/dispatcher with explicit cost and loop controls, not merely a stronger prompt.

## Dispatch performance

Quota tracking belongs to the parent session: the companion `pi-better-usage` extension returns before registration when `PI_OMP_CHILD=1`, avoiding child account lookups, quota requests, and refresh timers. Normal TUI/RPC registrations are unchanged.

Recordings accumulate complete JSONL events until 100 ms or 64 KiB, then write a batch. Completion, failure, and cancellation flush before closing. Timer write errors notify the child supervisor and remain observable at finalization; abrupt process termination can lose the last unflushed batch. Live replies update in memory independently of disk flushes.

Historical batches remain addressable by job ID and tool-call ID. Separate running and pinned sets drive animation and fixed-card refreshes, so released history is not scanned on each tick or render. Session reset/shutdown clears the indexes. Progress callbacks share frozen unchanged rows and activity lists, copy only the outer batch array, and publish text plus usage once per child event. Activity changes still force updates after the 32-entry history cap; terminal updates remain immediate.

OMP resolves configuration and enabled-model availability once per dispatch, reusing role launch settings across repeated assignments. All TUI batches share one 80ms animation timer; progress changes coalesce into a widget refresh, while animation-only ticks request a render of the existing components. Live assistant previews are bounded and updated as events arrive; private JSONL recordings still retain the full events. Duplicate cancellation checks and the unused usage aggregation helper have been removed.

Child RPC processes retain provider extensions, skip themes and prompt templates, and inherit project trust. Explorer, Librarian, Designer and Fixer load no skills; Oracle loads only the bundled `simplify` skill; Council reviewers inherit the main session's skills. The OMP child entry registers only the standalone `websearch` tool, without provider tier hooks or importing the parent runtime. A separate native MCP child extension provides a role-scoped in-memory config (only `gh_grep` for Librarian, empty for other specialists) while preserving provider and permission extensions. It does not change the parent registry or read inherited MCP files. Full process isolation is retained.

OMP exposes only model and thinking choices for specialists; it does not override provider service tiers. Obsolete speed settings are ignored.

## Task lifecycle and continuation

The September 2026 upstream review used `alvinunreal/oh-my-opencode-slim` commit `c09d679`: its orchestrator prompt emphasizes reusable completed sessions, per-task terminal results and explicit verification ownership. OMP adopts these workflow principles without importing the upstream job-board, polling or wake-scheduler implementation.

OMP uses Pi 0.99.0 RPC `prompt`, `get_state` and `abort`, and the `agent_settled` event. Each task owns a process/context and each continuation gets a distinct run ID. Completion requires settled/idle state and a successful recording flush. Intermediate messages and retry boundaries never release the task. Native Pi CLI integration is tested against a local mock HTTP provider, including warm continuation, eviction and cold restoration.

An ordinary batch is a display group, not a completion barrier. Each terminal result is delivered once per batch index, with a 50 ms coalescing window; the last result flushes immediately. Delivery failures retry only notification. Council retains its three-review barrier. Up to four idle specialist workers remain for two minutes; active work is not subject to that idle limit. Runtime replacement and shutdown wait for in-flight launches and process retirement. No automatic task replay, arbitrary cross-parent task-ID lookup or registry restoration is provided.
