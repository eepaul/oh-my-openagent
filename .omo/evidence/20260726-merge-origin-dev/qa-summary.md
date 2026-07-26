# origin/dev 合并 QA

## WHAT WAS TESTED

- `bun test packages/omo-opencode/src/features/background-agent/manager.test.ts packages/omo-opencode/src/features/background-agent/spawner/tmux-callback-invoker.test.ts`
  - 验证冲突解决同时保留外部目录审批继承，并采用上游 `invokeTmuxSessionCreatedCallback()` 路径。
- `bun run typecheck`
  - 在 `bun install` 刷新到锁文件声明的 TypeScript 7 后检查根项目、script 和所有 package。
- `PATH="/tmp/opencode:$HOME/.nvm/versions/node/v20.19.5/bin:$PATH" bun run test:codex`
  - 临时 PATH 中的 `python3` 指向现有 Python 3.11，使 TOML 断言可使用 `tomllib`；Node 20.19.5 满足 Vite/Rolldown engine 要求。
- `bash .agents/skills/codex-qa/scripts/install-verify.sh --self-test`
  - 将本地构建安装到隔离 `CODEX_HOME`，验证插件缓存版本、配置、组件 bin 和 agent TOML。
- `bash .agents/skills/codex-qa/scripts/app-server-drive.sh --plugin`
  - 使用真实 `codex app-server` 和本地 mock model 驱动隔离安装，验证插件 hooks 真实触发。
- `bash .agents/skills/opencode-qa/scripts/tui-smoke.sh --self-test`
  - 在隔离 XDG 环境中通过 tmux 启动真实 OpenCode TUI。
- `bash .omo/evidence/20260726-merge-origin-dev/opencode-local-plugin-qa.sh`
  - 通过 `file://.../packages/omo-opencode/src/index.ts` 加载本地插件，使用真实 `opencode run --format json` 和本地 mock model 完成一轮。

## WHAT WAS OBSERVED

- background-agent 定向测试：197 pass，0 fail。
- typecheck：退出码 0。
- Codex gate：514 pass，0 fail。
- Codex isolated install：插件缓存版本为 `4.19.1`，`omo@sisyphuslabs` 已启用，9 个组件 bin 和 agent TOML 均落在 sandbox，真实 `~/.codex/config.toml` hash 未变化。
- Codex app-server：turn completed；`sessionStart`、`userPromptSubmit`、`stop` 均有 `hook/started` 和 `hook/completed`，无 missing/failed hooks。
- OpenCode TUI：成功渲染、接收按键并清理 tmux session；真实 OpenCode DB session 数保持 4656。
- OpenCode local plugin run：返回 `FAKE_OK 2`；真实 OpenCode DB session 数从 4656 到 4656，未污染宿主状态。

## WHY IT IS ENOUGH

- 冲突文件的行为边界由 197 个 background-agent 测试覆盖，包含 manager 和新的 tmux callback helper。
- TypeScript 全仓类型检查覆盖合并后的 API 兼容性。
- Codex 生成 installer 的版本冲突通过完整 Codex gate、隔离安装和真实 app-server 三层验证。
- OpenCode 路径既通过定向逻辑测试，也通过本地源码插件在真实 CLI/TUI 表面的运行验证。
- 两个 harness 均提供宿主真实配置或 DB 未变化的隔离证明。

## WHAT WAS OMITTED

- 未调用真实模型 API；两个 harness 均使用本地 mock model，避免凭据和费用风险。
- 未复制环境变量、认证头或私有凭据到证据目录。
- 第一次 Codex app-server 与 install-verify 并行运行时发生生成目录 `EEXIST` 竞态；随后串行重跑通过，失败记录保留在 `codex-app-server.json`。
- 宿主默认 Node 22.11.0 不满足 Vite/Rolldown 的 `>=22.12.0` engine，默认 Python 3.10 不含 `tomllib`；最终 gate 使用机器已有的 Node 20.19.5 和 Python 3.11，不修改系统配置。
