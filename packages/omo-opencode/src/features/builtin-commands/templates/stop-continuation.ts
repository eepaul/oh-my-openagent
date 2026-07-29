export const STOP_CONTINUATION_TEMPLATE = `Stop all continuation mechanisms for the current session.

This command will:
1. Stop the todo-continuation-enforcer from automatically continuing incomplete tasks
2. Cancel any active Ralph Loop
3. Clear the active Goal for this session
4. Archive the boulder state for the current project as \`boulder.json.stopped-<timestamp>\`; if the same timestamp already exists, append \`-2\` and continue numbering collisions

After running this command:
- The session will not auto-continue when idle
- You can manually continue work when ready
- The stop state is per-session and clears when the session ends
- Report the system-injected boulder archive result to the user
- Do not rename or restore an archived boulder file yourself
- To resume archived boulder work, rename the archive back to \`.omo/boulder.json\`, then run \`/start-work <plan-name>\` in the session where work should continue to rebind it and clear the stop state
- If every task remains \`[~]\`, make the required decision and change the relevant \`[~]\` entries back to \`[ ]\`

Use this when you need to pause automated continuation and take manual control.`
