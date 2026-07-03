// Driver: run the REAL runtime-fallback classifier against the EXACT error
// object observed in the live opencode DB (session ses_0ddd7b681ffeMaYa9iKdAFnSef,
// project ~/projects/quant/kalshi-data-collector). Proves 方案 B end-to-end at
// the library surface: a ContentFilterError is now classified content_filter and
// is retryable, while control errors (abort / 400) keep their prior behavior.
//
// Run: bun run .omo/evidence/20260703-content-filter-runtime-fallback/driver.ts

import {
  classifyRuntimeFallbackError,
  getRuntimeFallbackStatusCode,
  isRuntimeFallbackRetryableError,
} from "../../../packages/model-core/src/runtime-fallback-error-classifier"

const RETRY_ON_ERRORS = [429, 500, 502, 503, 504] as const

const cases = [
  {
    label: "DB ContentFilterError (exact stored shape)",
    error: {
      name: "ContentFilterError",
      data: { message: "The response was blocked by the provider's content filter" },
    },
    expectType: "content_filter",
    expectRetryable: true,
  },
  {
    label: "control: MessageAbortedError",
    error: { name: "MessageAbortedError", data: { message: "Aborted" } },
    expectType: "abort",
    expectRetryable: false,
  },
  {
    label: "control: 400 ValidationError",
    error: { name: "ValidationError", statusCode: 400, message: "Invalid request payload" },
    expectType: undefined,
    expectRetryable: false,
  },
] as const

let allOk = true
for (const c of cases) {
  const type = classifyRuntimeFallbackError(c.error)
  const retryable = isRuntimeFallbackRetryableError(c.error, RETRY_ON_ERRORS)
  const statusCode = getRuntimeFallbackStatusCode(c.error, RETRY_ON_ERRORS)
  const ok = type === c.expectType && retryable === c.expectRetryable
  allOk = allOk && ok
  console.log(
    `[${ok ? "OK" : "FAIL"}] ${c.label}\n` +
      `      classify=${String(type)} retryable=${retryable} statusCode=${String(statusCode)}\n` +
      `      expected classify=${String(c.expectType)} retryable=${c.expectRetryable}`,
  )
}

console.log(allOk ? "\nRESULT: PASS" : "\nRESULT: FAIL")
process.exit(allOk ? 0 : 1)
