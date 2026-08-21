# QA 证据：为四份优化配置补齐 codex-config-jsonc 迁移标记

日期：2026-08-21 / 分支：dev

## 背景

`~/.omo/omo.jsonc` 是指向仓库内 `oh-my-openagent.optimized.jsonc` 的符号链接。
`2026-07-codex-config-jsonc` 迁移每次启动都被触发并失败，OpenCode 弹出
"Configuration migration failed" 错误 toast。

根因链：

1. `~/.omo/config.jsonc`（legacy 源）仍存在，且目标文件 `_migrations` 里没有该迁移
   标记，`shouldRunMigration`（`packages/omo-config-core/src/migration/predicate.ts`）
   判定需要跑。
2. 引擎准备写入目标时，`updateOmoConfig` 的 `assertConfigPathIsSafe`
   （`packages/omo-config-core/src/writer/writer.ts`）拒绝符号链接目标，抛出
   `Refusing to edit symlinked omo config`。
3. 抛错发生在写 journal 之后、写目标之前，`~/.omo/.migration-journal.json` 永久残留
   （实测 `targetWritten: false`、`completedMoves: []`）。
4. 之后每次启动 `runMigrations` 先跑 `resumeMigrationJournal`，撞同一堵墙，死循环。

修复方式：在目标文件的 `_migrations` 数组补上 `2026-07-codex-config-jsonc`。
`resumeMigrationJournal` 的写入被包在 `if (!hasMigrationMarker(...))` 里，标记存在后
唯一会失败的那一步被整体跳过，剩余收尾（移动 legacy 源、删除 journal）全部作用于普通
文件，可以正常完成。四份配置变体都改，是因为用户靠切换符号链接换配置，只改一份则切到
其它变体时同样的错误会再次出现。

## WHAT WAS TESTED

1. **根因复现（隔离沙箱，A/B 单变量）**：在临时 HOME 下复刻现场（symlink 目标 +
   legacy `config.jsonc`），只改「目标是符号链接 / 是普通文件」这一个变量，调用
   `runOpenCodeStartupMigration`。
2. **内容是否可省略（A/B）**：对比「仅加标记」与「加标记 + 迁移引擎实际会写入的
   additions」，跨 `opencode` / `codex` / `senpi` 三个 harness 比较 `loadOmoConfig`
   的解析产物。additions 取自残留 journal 的 `targetWrite.additions`，经
   `mergeWithoutClobber` 得到真实新增键集。
3. **改动后逐文件校验**：四份文件各跑 JSONC 解析、`OmoConfigSchema.safeParse`
   （迁移引擎写入前用的就是它）、三条迁移的 `shouldRunMigration`、以及插件真实入口
   `loadOmoOpenCodeConfigChain` 的诊断与 agents/categories 解析数。
4. **测试夹具回归**：`oh-my-openagent-openai-only.optimized.jsonc` 被
   `packages/omo-opencode/src/config/validate-model-chain.test.ts` 当夹具读取，改动前后
   各跑一次该测试，并用 `git stash` 在 HEAD 原始状态下复跑以归因失败。
5. **类型门禁**：`tsgo --noEmit -p packages/omo-opencode/tsconfig.json`。

## WHAT WAS OBSERVED

**1. 根因 A/B**

| 目标文件形态 | 结果 |
| --- | --- |
| 符号链接 | `error: Failed to read omo config at .../omo.jsonc: Refusing to edit symlinked omo config`；journal 残留、legacy 源残留 |
| 普通文件 | `status: "migrated"`；journal 清除、legacy 源归档进 backup 目录 |

**2. 内容可省略性 A/B**

迁移引擎 no-clobber 后实际会新增的键，只有三个空对象：

```json
{ "codegraph": {}, "[opencode]": { "codegraph": {} }, "[codex]": { "codegraph": {} } }
```

（`$schema` 已存在且值相同，被跳过，对应 journal 里的 `skipped:` 诊断。）

三个 harness 下「仅加标记」与「加标记 + 加内容」的解析产物完全一致，`codegraph` 均为
`{enabled:true, auto_provision:true, daemon:true, telemetry:false}`。原因是 loader 在
合并前铺了一层 `DEFAULT_RAW_CONFIG` 种子（`loader/loader.ts:165`），使「键缺失」与
「键为空对象」等价。结论：无需搬运 legacy 内容，只加标记即可，不丢配置。

**3. 改动后逐文件校验（4/4 PASS）**

| 文件 | JSONC | OmoConfigSchema | 三条迁移仍触发？ | 插件链诊断 | agents/categories |
| --- | --- | --- | --- | --- | --- |
| `oh-my-openagent.optimized.jsonc` | ok | ok | 全部 false | 无 | 13 / 8 |
| `oh-my-openagent-no-anthropic.optimized.jsonc` | ok | ok | 全部 false | 无 | 13 / 8 |
| `oh-my-openagent-no-openai.optimized.jsonc` | ok | ok | 全部 false | 无 | 11 / 8 |
| `oh-my-openagent-openai-only.optimized.jsonc` | ok | ok | 全部 false | 无 | 12 / 8 |

三条迁移指 `2026-07-codex-config-jsonc`、`2026-08-reasoning-unification`、
`2026-07-opencode-config-unification`，均按最坏情况（假设 legacy 源仍存在）求值，
`shouldRunMigration` 全部返回 `false`。

**4. 测试夹具回归**

改动前该测试 `3 pass / 1 fail`。`git stash` 撤回全部改动、在 HEAD 原始状态下复跑，
失败签名逐字一致（期望对象缺少 `review-gpt-agent`），确认为**既有失败，与本次改动无关**：
夹具含 12 个 agent（11 个内置 + 自定义 `review-gpt-agent`），而断言仍写 11 个。

该断言已在同批工作中对齐（`validate-model-chain.test.ts`：期望对象补上
`"review-gpt-agent": { model: "openai/gpt-5.6-sol", reasoning: "xhigh" }`，标题
`eleven` 改 `twelve`），修复后 `4 pass / 0 fail`。

**5. 类型门禁**

`tsgo --noEmit -p packages/omo-opencode/tsconfig.json` → exit 0，无输出。

**隔离证明**：所有验证均在 `mktemp` 出的临时 HOME 下进行，真实 `~/.omo/omo.jsonc`、
`~/.omo/config.jsonc`、`~/.omo/.migration-journal.json` 全程未被读写修改；未调用
`runMigrations` 直打真实 HOME（该函数即使 `dryRun` 也会先执行 `resumeMigrationJournal`
并尝试真实写入，见下方遗留风险）。临时脚本与沙箱目录已在验证后清理。

## WHY IT IS ENOUGH

- 根因由单变量 A/B 直接证明，不是推断：同一段代码路径，只切换目标文件形态，成功与失败
  各复现一次。
- 修复的等价性由跨三 harness 的解析产物比对证明，覆盖了「只加标记会不会丢配置」这个
  唯一实质风险。
- 改动是纯数据（`_migrations` 数组追加一个字符串），不触碰任何运行时代码路径；四份文件
  逐一过了迁移引擎写入前用的同一个 schema，以及插件的真实加载入口。
- 唯一消费这些文件的产品代码是 `validate-model-chain.test.ts`，已跑并归因；其失败在
  改动前即存在，且已在同批修复。

## WHAT WAS OMITTED

- **未驱动真实 OpenCode 会话**。本改动不含运行时代码，只改配置数据文件与一处测试断言，
  插件加载路径已由 `loadOmoOpenCodeConfigChain` 的直接调用覆盖（零诊断、agents/categories
  完整解析）。真实 harness 冒烟对这次改动无额外信息量。
- **未跑仓库全量 `bun test`**。只跑了唯一消费改动文件的测试文件，以及包级 `tsgo` 类型门禁。
- **`lsp_diagnostics` 未执行**：本机未安装 `typescript-language-server`，已按流程记录为
  declined，未擅自安装；改用仓库自身的类型门禁 `tsgo` 顶替，覆盖等价。
- **未收录任何密钥**：验证过程不涉及 token / auth header / 凭据；配置文件中只含模型
  标识符与并发数，无敏感值。
- **未在本次改动中修复的遗留缺陷**：`runMigrations`（`migration/batch.ts:186`）在
  `dryRun` 检查之外先执行 `resumeMigrationJournal`——`dryRun` 只在 `executePlan`
  内部（同文件 :137）生效。因此当 journal 残留时，`omo config migrate --dry-run` 会真实
  写目标文件并移动 backup，违背 `--dry-run` 契约。属独立问题，未在此改动范围内处理。
