# Learnings — boulder-waiting-on-human-state

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## [2026-07-31T05:25:09Z] Task: todo-1

- `BoulderState` 根字段是活动 work 的镜像；`waiting` 必须在 legacy 合成、work→root 投影和 root→work 写入三处同步，任一缺失都会让会话追加后的状态不完整。
- `isValidWorkStatus` 驱动恢复选项的 unknown→`active` 回退。将 `waiting_on_human` 纳入合法集合即可保留它的状态，且未知 `bogus` 行为保持不变。
- `getActiveWorks` 仅排除 `completed` 和 `abandoned`，不应把 `waiting_on_human` 纳入排除集合。

## [2026-07-31T05:35:27Z] Task: todo-2

- 等待转换必须构造新的目标 work 和 `works` 映射，只有目标是 `active_work_id` 时才调用 `projectWorkToMirror`，这样其他 work 的序列化内容不会被镜像同步污染。
- `writeBoulderState` 的布尔结果可直接作为转换结果；写入失败时未落盘的对象不会改变重读语义，调用方仍可将该 work 视为等待状态。
- `resumeFromHuman` 对非等待 work 返回成功但不写文件，避免给恢复调用方制造额外状态变更。

## [2026-07-31T05:47:53Z] Task: todo-3

- 统一谓词必须先以 `readFileSync` 加 `parsePlanChecklist` 完成一次可判定的读取；既有 `getPlanChecklist` 会把读取失败折叠成空清单，不能区分 unreadable 与 runnable。
- 只有结构化解析至少识别到一个普通或 blocked checkbox 时才认为计划可读，缺失文件和不含清单的损坏内容都 fail-closed。
- `plan-blocked` 的 runnable/complete stale 只上报不写入；测试通过调用前后 `boulder.json` 字节相同锁定零写契约，`question-tool` 不受计划形状的 stale 影响。

## [2026-07-31T06:30:00Z] Task: todo-4

- fail-closed 状态必须以 `path.resolve(directory)` 的嵌套 Map 隔离；字符串拼接键会让 `("/a", "bc")` 和 `("/ab", "c")` 碰撞。
- 促升、stale 自愈和人类恢复共享同一 per-work 队列，epoch 只能在队列内推进，才能让迟到的促升 CAS 自然失效。
- Atlas 的异步 idle、inject 和 retry 点可统一调用 `checkWorkWaiting`；同步 prompt pre-dispatch guard 只能做 fresh-read 的零注入阻止，完整异步转换发生在前置消费点。
