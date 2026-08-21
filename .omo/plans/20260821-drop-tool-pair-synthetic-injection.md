# 删除 tool-pair 合成部件注入，transform 层对齐 upstream

**分支:** `chore/drop-tool-pair-synthetic-injection`
**基点:** `876f28a00`（同步上游 dev 的合并提交）

## 为什么

`tool-pair-repair-injector` 向 `experimental.chat.messages.transform` 的消息流注入合成的
`{type:"tool_result"}` 部件，意图是补上缺失的 tool_result 块。这个意图从未达成：

- `tool_result` 不在 OpenCode 的 `Part` 联合里（`TextPart | SubtaskPart | ReasoningPart |
  FilePart | ToolPart | StepStartPart | StepFinishPart | SnapshotPart | PatchPart | AgentPart |
  RetryPart | CompactionPart`），`MessageV2.toModelMessagesEffect` 在构造请求前把它丢弃。
- 上游 2026-08-05 的 QA 证据（`.omo/evidence/20260805-tool-pair-validator-real-parts/README.md`）
  已对同形状的旧实现给出实测结论，并留下 `conversion-invariant.test.ts` 的
  "no foreign part type" 断言。
- 本地实测探针：注入 1 个 `tool_result`，能到达 provider 的是 0 个。

唯一能存活的是那条 `{type:"text", text:"Recovered missing tool results. Continue from the
repaired tool output."}`，即向模型声称"已恢复"，而实际没有恢复。净负面。

上游已用正确方式解决同一问题：`toolPairValidator` 的 `repairUnpairedToolParts` 就地把非终态
`tool` 部件落定为终态 error。因为 OpenCode 把终态 `tool` 部件同时展开成 tool_use + tool_result
两个块，配对天然完整；而且是预防式（每次 transform 都跑），不是等 400 之后才反应。

## 保留什么

`tool_pair_mismatch` → `runFallback`（summarize retry）这条反应式恢复路径**保留**。它确实生效，
只是过去被绑在无效的注入旁边。用户已明确选择该边界。

## 变更清单

### 删除文件
| 文件 | 理由 |
|---|---|
| `hooks/anthropic-context-window-limit-recovery/tool-pair-repair-injector.ts` | 注入器本体 |
| `hooks/anthropic-context-window-limit-recovery/tool-pair-repair-injector.test.ts` | 其测试 |
| `hooks/anthropic-context-window-limit-recovery/tool-result-resolver.ts` | 唯一消费方是被删的合成部件生产路径 |
| `hooks/anthropic-context-window-limit-recovery/tool-result-resolver.test.ts` | 其测试 |
| `hooks/anthropic-context-window-limit-recovery/zauc-mocks-tool-pair-repair-strategy/` | 整目录：mock 的 `resolveToolOutputs` 已不存在，断言的是被删的合成消息存储 |

### 修改文件
| 文件 | 变更 |
|---|---|
| `plugin/hooks/create-transform-hooks.ts` | 删 import、`TransformHooks.toolPairRepairInjector` 字段、创建块、返回字段；若 `getAutoCompactState` 参数因此无消费方则一并删 |
| `plugin/hooks/create-core-hooks.ts` | 若上一条删了参数，同步删传参 |
| `plugin/messages-transform.ts` | 删 `MessagesTransformHooks.toolPairRepairInjector` 字段与 `MESSAGES_TRANSFORM_HOOKS` 条目 |
| `hooks/anthropic-context-window-limit-recovery/index.ts` | 删 `createToolPairRepairInjectorHook` 导出 |
| `hooks/index.ts` | 同上 |
| `config/schema/hooks.ts` | 删 `"tool-pair-repair-injector"` 钩子名 |
| `hooks/anthropic-context-window-limit-recovery/types.ts` | 删 `ToolPairRepairTextContent` / `ToolPairRepairToolResultPart` / `ToolPairRepairContinuationPart` / `ToolPairRepairSyntheticMessage`；删 `AutoCompactState.toolPairRepairMessagesBySession` 与 `toolPairRepairBySession` |
| `hooks/anthropic-context-window-limit-recovery/recovery-hook.ts` | 删两处 `toolPairRepairMessagesBySession?.delete()`；删 `createRecoveryState` 里的 `toolPairRepairBySession` |
| `hooks/anthropic-context-window-limit-recovery/state.ts` | 删 `toolPairRepairBySession.delete()` |
| `hooks/anthropic-context-window-limit-recovery/tool-pair-repair-strategy.ts` | 缩减为：非 `TOOL_PAIR_MISMATCH` 直接返回，否则 `runFallback`。删除幂等集合、合成消息生产、resolver 调用 |
| `hooks/tool-pair-validator/types.ts` | 收回 `TransformPart = Part`；删 `ToolUsePart` / `ToolResultPart` / `SyntheticTextPart` 及其说明注释 |
| 测试夹具 4 处 | `aggressive-truncation-strategy.test.ts` / `executor.test.ts` / `summarize-retry-strategy.test.ts` / `recovery-hook-regression.test.ts`：去掉已删的 state 字段 |
| `CHANGELOG.md` | Removed 条目 |

### 行为变化（需在 PR 与证据中说明）
1. 不再向 transform 流注入任何合成部件；模型不再收到那句不实的 "Recovered missing tool results"。
2. `tool_pair_mismatch` 的幂等短路消失：同一 mismatch 重复出现时，现在每次都会走 `runFallback`，
   由 `shouldRunSummarizeFallback` 的 `RETRY_CONFIG.maxAttempts`（2）封顶，而不是靠
   `${messageIndex}:${toolUseID}` 集合提前 return。

## 验证

| 关卡 | 命令 | 期望 |
|---|---|---|
| 类型 | `bun run typecheck` | exit 0 |
| 构建 | `bun run build` | exit 0 |
| 单测 | `bun test` | 仅剩已知既有失败（对照 `backup/dev-before-upstream-sync-20260821` 与 `origin/dev` 基线） |
| 转换不变量 | `bun test packages/omo-opencode/src/hooks/tool-pair-validator` | 全绿；这是上游的 "no foreign part type" 守卫 |
| 真实 QA | `opencode-qa` 技能，隔离 XDG 沙箱 | 插件加载正常、transform 链无 `toolPairRepairInjector`、真实会话跑通；证据写入 `.omo/evidence/20260821-drop-tool-pair-synthetic-injection/` |

## 回滚

`git revert` 本分支的提交即可；被删代码在 `876f28a00` 及更早历史中完整可取。
