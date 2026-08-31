import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

export interface ToolExecutionStats {
  readonly active: number
  readonly calls: number
  readonly errors: number
  readonly durationMs: number
}

export interface RuntimeObservabilitySnapshot extends ToolExecutionStats {
  readonly tools: Readonly<Record<string, ToolExecutionStats>>
}

type Clock = () => number

interface MutableToolExecutionStats {
  active: number
  calls: number
  errors: number
  durationMs: number
}

function emptyStats(): MutableToolExecutionStats {
  return { active: 0, calls: 0, errors: 0, durationMs: 0 }
}

/**
 * Backend-neutral aggregate of tool execution lifecycle metadata.
 *
 * The observer deliberately stores no arguments, result content, prompts, or
 * exception messages. PR3 can project these counters and durations into an
 * OpenTelemetry backend without widening the data boundary established here.
 */
export class ToolExecutionObserver {
  private readonly byTool = new Map<string, MutableToolExecutionStats>()
  private readonly total = emptyStats()

  constructor(private readonly clock: Clock = performance.now.bind(performance)) {}

  /**
   * Wrap one `tools/execute` delegation and preserve its exact result/error
   * semantics while tracking active calls, completions, failures, and duration.
   */
  async observe(
    toolName: string,
    next: () => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult> {
    const tool = this.statsFor(toolName)
    const startedAt = this.clock()

    this.total.active += 1
    tool.active += 1

    try {
      const result = await next()
      this.finish(tool, startedAt, result.isError)
      return result
    } catch (error) {
      // A tool body is normally normalized into ToolExecutionResult by the
      // registry. A downstream around-dispatch wrapper may still throw, so the
      // observer must restore active gauges and count that terminal path too.
      this.finish(tool, startedAt, true)
      throw error
    }
  }

  snapshot(): RuntimeObservabilitySnapshot {
    const tools = Object.fromEntries(
      [...this.byTool.entries()].map(([name, stats]) => [name, this.copy(stats)]),
    )

    return Object.freeze({
      ...this.copy(this.total),
      tools: Object.freeze(tools),
    })
  }

  private statsFor(toolName: string): MutableToolExecutionStats {
    let stats = this.byTool.get(toolName)
    if (stats === undefined) {
      stats = emptyStats()
      this.byTool.set(toolName, stats)
    }
    return stats
  }

  private finish(
    tool: MutableToolExecutionStats,
    startedAt: number,
    isError: boolean,
  ): void {
    const durationMs = Math.max(0, this.clock() - startedAt)

    this.total.active -= 1
    this.total.calls += 1
    this.total.durationMs += durationMs

    tool.active -= 1
    tool.calls += 1
    tool.durationMs += durationMs

    if (isError) {
      this.total.errors += 1
      tool.errors += 1
    }
  }

  private copy(stats: MutableToolExecutionStats): ToolExecutionStats {
    return Object.freeze({
      active: stats.active,
      calls: stats.calls,
      errors: stats.errors,
      durationMs: stats.durationMs,
    })
  }
}
