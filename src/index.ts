import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ToolExecutionObserver } from './tool-observer.ts'

export { ToolExecutionObserver } from './tool-observer.ts'
export type {
  RuntimeObservabilitySnapshot,
  ToolExecutionStats,
} from './tool-observer.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshRuntimeObservability: ToolExecutionObserver
  }
}

export const name = 'dsh-runtime-observability'
export const inject = ['tools']

/**
 * Instrument the DeepSeek Harness `tools/execute` around-dispatch seam.
 *
 * PR2 keeps observations in a backend-neutral in-memory aggregate. No prompt,
 * tool arguments, tool result content, or exception messages are retained.
 */
export function apply(ctx: Context): void {
  const observer = new ToolExecutionObserver()
  ctx.provide('dshRuntimeObservability', observer)

  ctx.on(
    'tools/execute',
    (exec, next): Promise<ToolExecutionResult> => observer.observe(exec.name, next),
  )
}
