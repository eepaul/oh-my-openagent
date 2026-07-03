# content-filter → runtime-fallback 可重试(方案 B)

日期: 2026-07-03 / 分支: dev / 改动包: `@oh-my-opencode/model-core`

## 背景

真实 opencode DB(`~/.local/share/opencode/opencode.db`)里 session
`ses_0ddd7b681ffeMaYa9iKdAFnSef`(“Migrate WS内存优化方案”,项目
`~/projects/quant/kalshi-data-collector`)最后一条 assistant 消息存的错误对象:

```json
{
  "finish": "content-filter",
  "modelID": "claude-fable-5",
  "providerID": "anthropic",
  "error": {
    "name": "ContentFilterError",
    "data": { "message": "The response was blocked by the provider's content filter" }
  }
}
```

`has_statusCode: false` / `has_isRetryable: false`。该错误无 HTTP 状态码,旧的
`isRuntimeFallbackRetryableError` 判为不可重试 → runtime-fallback 直接
`Error not retryable, skipping fallback`,从不切换 fallback 模型。

## 改动

`packages/model-core/src/runtime-fallback-error-classifier.ts`:
- `RuntimeFallbackErrorType` 增加 `content_filter`
- `classifyRuntimeFallbackError`: `errorName` 含 `contentfiltererror` 或 message
  命中 `/content.?filter/i` → 返回 `content_filter`
- `isRuntimeFallbackRetryableError`: `content_filter` 并入可重试组(与
  missing_api_key / model_not_found / quota_exceeded 同级),不依赖状态码

配置侧无需改动:`retry_on_errors` 只认状态码,对无状态码的 content-filter 无效。

## WHAT WAS TESTED

- 单元(model-core): `runtime-fallback-error-classifier.test.ts` 新增用例,
  锁定 DB 的确切错误形状(含 `data.message` 嵌套、名字-only、message-only 兜底)。
- Hook 集成(omo-opencode): `event-handler.test.ts` 新增用例,给
  runtime-fallback 事件处理器喂 `session.error{ ContentFilterError }` + 配了
  `fallback_models`,断言真的派发到下一个 fallback 模型。
- 库层 driver: `driver.ts` 用真实分类器跑 DB 确切错误对象 + 两个对照
  (MessageAbortedError、400 ValidationError)。见 `driver-output.txt`。
- 类型检查: `tsgo --noEmit` model-core + omo-opencode → EXIT=0。
- 构建: `bun run build` → BUILD_EXIT=0。
- 全量回归: `bun test` → 见 `full-test-summary.txt`。

## WHAT WAS OBSERVED

- driver(`driver-output.txt`): `RESULT: PASS`。ContentFilterError →
  `classify=content_filter retryable=true statusCode=undefined`;两个对照行为
  不变(abort=不可重试、400=不可重试)。
- 新增两个 content-filter 测试均 `(pass)`:
  - `runtime fallback error classifier > classifies provider content-filter blocks as a retryable content_filter error`
  - `createEventHandler > #given a provider content-filter block #when session.error carries ContentFilterError #then the next fallback model is dispatched`(派发模型 = `anthropic/claude-opus-4-8(max)`)。
- 全量(`full-test-summary.txt`): `10432 pass, 2 skip, 0 fail`(2 skip 为
  team-mode 实时 tmux smoke,环境相关,与本改动无关)。

## WHY IT IS ENOUGH

- 阻塞点是纯分类器逻辑;driver 用 DB 的**逐字**错误对象跑的就是生产同一函数,
  event-handler 测试证明 runtime-fallback 钩子在该错误下确实走到 fallback 派发。
- 对照用例保证未扩大重试面(abort、400 仍不可重试)。
- 全量套件无回归。

## WHAT WAS OMITTED

- 未对真实 provider 触发一次实时 content-filter:该 finish reason 无法确定性诱发
  (取决于 provider 内容策略)。以 DB 逐字错误对象 + hook 集成测试作为等价证据。
- 未附带真实密钥/日志:driver 与测试均为纯逻辑,无 provider 调用、无凭据。
