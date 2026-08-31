import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'dsh-runtime-observability'
export const inject = ['tools']

/**
 * Bootstrap the runtime observability plugin.
 *
 * PR1 deliberately does not record or export telemetry yet. It only attaches
 * an observe-only listener to the authoritative `tools/result` seam so the
 * plugin's dependency and lifecycle behavior are exercised against Cordis.
 */
export function apply(ctx: Context): void {
  ctx.on('tools/result', () => undefined)
}
