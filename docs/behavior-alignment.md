# 行为对齐记录

> 本文主体记录行为对齐阶段的范围和证据，并非当前全部功能清单。后续按用户要求合并远端 `059eef1`：保留 Fast 开关、用量页脚、DCP 继承及界面对齐，并将开发依赖同步到 Pi 0.99.2；退出清理、不恢复任务的优先级保持不变。旧恢复记录仅供历史用量迁移，不会启动子任务。新增真实父会话重开回归测试验证此边界。Pi 1.0.2 的 MCP 启动等待修复也予以保留。

## 范围与优先级

对齐 OpenCode + omo-slim 的**任务执行行为**，不移植界面或设置。用户明确要求优先于上游默认：

- 退出清理；恢复 Pi 会话时不恢复旧 OMP 任务、任务 ID 或卡片。
- ESC 取消主任务时，连带取消所有未完成的子任务。
- 保留 OMP 的固定任务卡片、角色模型/思考配置、Council、中文任务传递、MCP 策略及其他个性化功能。界面布局、设置结构和默认值不属于本轮修改范围。
- 不删除 Pi 聊天记录，不回滚项目文件，不清扫其他 Pi 实例或历史版本留下的文件。

“对齐”不是直接复制上游代码，也不是声称两个宿主已经完全等价。先核对源代码，再用 OMP 回归测试验证可以复用的行为；有意差异单独记录。

## 固定研究版本

- Pi：本项目依赖的 `@earendil-works/pi-coding-agent@0.99.0`。核对 `docs/extensions.md`、`docs/sessions.md`、`docs/keybindings.md` 及 `dist/core/agent-session.js`、`dist/modes/interactive/interactive-mode.js`。
- [OpenCode `907b3bc518fa48e90e8ec24dd327d13eee71c36c`](https://github.com/anomalyco/opencode/tree/907b3bc518fa48e90e8ec24dd327d13eee71c36c)。本轮核对 `packages/opencode/src/tool/task.ts` 的取消和后台分支。
- [omo-slim `0516c8366a4ac44bcf1b7bfbf5d4289f87028279`](https://github.com/alvinunreal/oh-my-opencode-slim/tree/0516c8366a4ac44bcf1b7bfbf5d4289f87028279)。本轮核对 `src/agents/orchestrator.ts`、`src/hooks/task-session-manager/tool-execute-hooks.ts`、`event-router.ts`、`revived-run-tracker.ts` 的相关分支。

以上是源代码对照和本地离线验证，不是上游真实账号或交互端到端验收。

## 本轮行为与证据

| 行为 | 上游/宿主依据 | OMP 决策与验证 |
| --- | --- | --- |
| 取消传到子任务 | OpenCode `task.ts` 前台等待分支监听 `ctx.abort`，中断时取消子会话；后台分支有独立生命周期 | 按用户要求扩大为取消当前 OMP runtime 所有未完成批次及 Council。`tests/orchestration-integration.test.ts` 的 `parent cancellation stops every batch...` 验证五个运行中的子进程退出，并保留已完成结果 |
| 取消后不自动继续 | omo-slim `revived-run-tracker.ts` 的 cancelled 分支只收尾，不走 completed/error 通知路径 | OMP 保留取消结果作为上下文，但 `triggerTurn: false`。同一集成测试及 `notification retries ... respect parent cancellation` 覆盖普通结果和通知重试 |
| 原生 ESC/RPC 取消 | Pi 默认 `app.interrupt` 为 ESC，主编辑器取消调用 `session.abort()`；扩展通过 `ctx.signal` 接入 | 不抢占 ESC、不改快捷键或菜单。`tests/rpc-integration.test.ts` 在真实 Pi SDK 中调用原生 abort，验证取消日志及模型请求不增加；并非模拟键盘截图测试 |
| 压缩阶段取消 | Pi `session_before_compact.signal` 对应独立于主 Agent 的压缩控制器 | 三种 reason（manual/threshold/overflow）信号均取消子任务；成功、失败、扩展 veto、切换会话均移除旧监听。`native compaction abort...` 在真实 SDK 中调用 `abortCompaction()`，验证无主 Agent 信号时子进程仍退出、没有模型唤醒 |
| 压缩中的完成通知 | Pi `sendCustomMessage(triggerTurn: true)` 在无主 Agent 运行时会直接开始模型；手动压缩的 `session_compact` 又早于实际空闲，因此需额外交付边界 | **已复现并修复**：旧实现在摘要未完成时已产生一个父模型请求。现在先缓存结果，终态后若无可接收 steering 的主回合，再本地等到 native idle 才唤醒。真实 SDK 的 `native compaction complete/veto...` 覆盖摘要执行中（包括摘要扩展先注册）、后续扩展终态钩子等待中均无提前请求，以及随后单次交付；`cancel-completed` 验证压缩取消保留已完成结果但不触发模型；`pending delivery retries pause...` 覆盖通知重试暂停、取消后不唤醒、重载丢弃旧待交付结果 |
| 子任务终态不等于验收通过 | OpenCode `task.ts` 明确转发子会话错误；omo-slim orchestrator 要求 reconcile/verify、拒绝后调整范围，不能因取消而跳过必要验证 | 已有 `length`、模型重试失败及进程退出失败路径保留；新增空白最终回复失败（包括超出本地截断限额的空白）及显式同 ID 续接测试。`OK` 仅说明正常终态与非空回复，拒绝/阻塞文本原样返回，父代理按验收条件判断，不加关键词分类器；共享编排指引及 Council 结果头明确此区别 |
| 长报告保留末尾限制条件 | OMP 原先只取前 20,000 字符，可能抹掉末尾测试失败说明；上游的验证责任原则要求保留限制条件并披露缺失证据 | **已复现并修复**：首尾保留，正文含标记总计不超过 20,000 UTF-16 单元，不拆 surrogate pair；`outputTruncated` 在模型通知中提示报告不是完整验收证据。完整日志不变，不新增摘要模型请求。task-session 测试覆盖尾部 caveat、精确长度边界、Unicode；delegate/Council 集成测试验证通知中的 warning 与末尾阻塞说明 |
| 父模型重试中的完成通知 | Pi `isStreaming` 覆盖整个主任务；低层 `ctx.signal` 在重试倒计时不存在，但后续 `agent_start` 可接收 steering | 复用非空闲/无 Agent 信号的本地等待边界，新的 `agent_start` 立即提交待交付结果。真实 SDK 的 `native goal follow-ups... retry: true` 在两种 goal 注册顺序下制造 503，验证子任务先完成却不跳过重试等待、下个模型请求已包含结果，且没有重复结果或只等待的空转 |
| 退出后不恢复 | omo-slim 有 retained-session/recovery 路径，其实例销毁还区分共享与局部状态 | **有意不同**：OMP 在 quit/reload/new/resume/fork/tree 后清空 runtime，删除自身临时文件。六种边界的 `... discards owned OMP files ...` 测试覆盖旧 ID 拒绝、旧卡片不恢复、新任务仍可执行 |
| 清理不干扰别的会话 | OMP 子进程与文件由本地注册表持有 | `tests/task-sessions.test.ts` 验证重复清理、启动途中清理、另一注册表的子进程/文件不受影响、新一代任务文件保留 |
| 过期派发不得启动 | omo-slim 异步恢复后检查 disposed/lifecycle 状态 | OMP 对模型配置等待加 runtime/取消代际检查；`shutdown/abort during model reconciliation...` 验证没有子会话创建、没有过期配置修复或通知 |
| 同一运行期内显式续接 | omo-slim 使用精确 session ID，禁止运行中任务被 resume/amend | 保留 OMP `taskId`，不新增上游工具名。现有 task-session 测试覆盖同进程续接、空闲淘汰后冷续接、运行中/未知/跨作用域 ID 拒绝。退出后这些 ID 永久失效 |
| 运行中追加要求 | omo-slim orchestrator 的 Active Task Amendments 要求在父会话保留追加说明，原任务终态后再续接；不能因追加而取消或重复创建 | OMP 共享编排指引及运行中 ID 的拒绝理由明确此行为；`an additive user request...` 验证新用户输入不取消工作、提前续接未发送新 prompt/未创建进程、原任务成功后同 PID/taskId 接收追加要求。自动识别“相同语义目标”仍是模型指引，不是关键字调度器 |
| 独立任务并行、按结果推进 | omo-slim orchestrator 要求独立 lane 并行、不轮询、校验写入范围和验证责任 | 保留已有后台派发与逐任务结果通知；现有 orchestration/RPC 测试覆盖并行、快结果先交付、避免 goal 空转。提示词约束不是文件锁或执行隔离保证 |

## 保留且不改造

本轮不修改 `config.ts`、`settings-ui.ts`、`roles.ts`、`render.ts`、`pinned-scroll.ts`、语言策略和 MCP 策略。旧卡片不恢复属于会话生命周期行为调整，不是重做现有卡片界面。

取消不等于撤销编辑。取消后的同一 runtime 仍可在检查部分成果后显式续接；正常退出/重载后则只能创建新任务。SIGKILL 等硬终止不能保证完成文件清理；残留文件不自动恢复，亦不在下次启动时全局删除。

## 后续逐项核对（尚未宣称完成）

- 追加需求的核心续接路径已补测；仍需核对用户明确替换目标、多个依赖任务同时追加、父会话压缩后的任务指引。当前追加说明保留在父会话，不新增自动投递队列或 live-message 工具。
- 子任务失败、模型输出限额、空白回复、本地报告截短已补证据；“OK 不是验收通过”是共享编排指引，不能把提示词测试当成模型永远正确理解拒绝/阻塞文本的证明。仍需在实际使用中核对复杂任务的语义验收。
- 压缩期间完成通知的竞态、父模型 503 重试期间交付已做真实 SDK 回归；新增 `exhausted: true` 验证关闭额外 goal 推进后，父模型重试耗尽没有空转请求，已交付子结果仍能在下一条用户消息中使用，且没有重新创建子任务。仍需核对多条新消息及迟到结果等组合，不把有限场景测试当作所有时序均已验证。
- **已确认的宿主限制：重试倒计时取消**。Pi 0.99 的 `abortRetry()` 仅终止 `_retryAbortController`；`ctx.signal` 只提供低层 Agent 信号，倒计时时通常不存在。`auto_retry_end` 是 SDK/RPC 流事件，不是扩展事件；最终边界 outcome 也不能区分重试取消和重试耗尽。此阶段 ESC 或 RPC abort 尚不能可靠传给 OMP 子任务。需要 Pi 暴露操作取消/重试结束的扩展事件，或经用户确认的宿主集成；不能全局拦截 ESC、修改菜单、扫描错误文本或将所有父模型错误误判为用户取消。普通主回合、等待子结果、对应 RPC abort 和压缩取消已覆盖，不等于重试倒计时已覆盖。
- **压缩取消的扩展顺序限制**：Pi 顺序等待 `session_before_compact`；更早的异步 handler 会延后 OMP 观察 signal，而该 handler 若返回 `{ cancel: true }` 会直接短路后续 handler。此时 OMP 不能区分用户取消与扩展自身 veto。通知交付已独立于这个顺序做防护，但即时联动取消仍需要宿主提供不被 veto 短路的操作取消事件，不能用 `session_compact_failed.aborted` 代替可靠信号。
- 并行写入/依赖规则已核对：omo-slim orchestrator 明确称 ownership/dependency 标签为 advisory，要求 reconcile 全部 writer 后再做最终验证。OMP 同样用编排指引约束写入范围与验收依赖；`TaskSessions.validate/claim` 强制的是任务 ID、role/cwd/trust、busy 及运行代次，不是文件锁或依赖图调度器。两者不能混为一谈；本轮不增加隐式文件锁、强制工作树隔离或关键词调度。
- 续接边界已核对：上游取消保留 session，OMP 当前 runtime 内也允许检查部分成果后显式续接；跨退出恢复则按用户要求刻意禁用，不复制上游 recovery。
- **仍有功能范围差异：定向取消单个任务**。上游 `src/tools/cancel-task.ts` 的 `task_cancel` 绑定父会话及捕获的 generation，在确认停止后才能释放运行权。OMP 当前只有父级全体取消，没有面向模型的单任务取消工具；不能声称支持用户在不中断其他 lane 的情况下替换某个运行目标。是否扩展工具接口需单独确认，不通过复用 `taskId` 偷偷取消并重跑原任务。

每一项先确定行为差异和验证场景，再做最小修改；不借行为对齐之名增加设置、改界面或删个性化功能。

## 阶段审计与下一步依赖

- 研究证据：上面的固定 Pi/OpenCode/omo-slim 版本及具体源码路径；结论限于已检查的执行流程，不声称审完所有上游功能。
- 已实现的用户要求：退出/重载/会话替换清理自身文件、不恢复旧任务；普通父级取消及可观察到的压缩取消联动子进程；保持现有界面、设置、角色配置、Council、语言与 MCP 策略。证据见对应表格及测试名称。
- 最近的代码验收：`bun run check` 通过类型检查和 **240 tests / 1666 assertions**；`git diff --check` 通过。`config.ts`、`settings-ui.ts`、`roles.ts`、`render.ts`、`pinned-scroll.ts`、`language.ts`、`mcp-policy.ts`、`child-mcp.ts`、`package.json`、`bun.lock` 与起始 HEAD 没有差异。之后本次审计仅改文档，不重复运行未受影响的测试。
- **尚不能宣布全部完成**：全阶段 ESC 联动仍有上述宿主 API 缺口；单任务定向取消尚未提供；真实模型的语义验收也不能由离线用例替代。

闭合 ESC 缺口需要先确认是否允许把工作范围扩展到 Pi 宿主。最低接口需求（这是待讨论契约，**不是 Pi 0.99 已有 API**）：

1. 当原生 agent/retry/compaction 的取消真正发生时，向该父会话的扩展公开可靠信号；菜单 ESC、扩展 veto、普通错误或重试耗尽不能冒充用户取消。
2. 取消通知不能被更早的、长时间等待的 `session_before_compact` handler 阻挡或短路；不能要求 OMP 抢占键盘。
3. 带有足够的会话/操作代次身份，防止迟到的旧取消事件影响新会话或新派发。
4. 用真实 SDK 验证重试等待取消、早注册摘要扩展、两种扩展注册顺序，以及完成结果保留、子进程退出、取消后零额外模型唤醒。

未获确认前，不修改全局 Pi 安装、锁定依赖版本或绕过其私有接口。若保持纯插件范围，应明确接受已列出的限制；若下一步改为单任务定向取消，也需确认可以扩展 OMP 的工具接口，但不需要改造 TUI 或设置。
