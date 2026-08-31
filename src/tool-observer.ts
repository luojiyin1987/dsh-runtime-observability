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

export interface ToolExecutionStarted {
  readonly toolName: string
}

export interface ToolExecutionCompleted extends ToolExecutionStarted {
  readonly durationMs: number
  readonly isError: boolean
}

/** Metadata-only lifecycle sink for one observed tool execution. */
export interface ToolExecutionLifecycleSink {
  onStart?(event: ToolExecutionStarted): void
  onComplete?(event: ToolExecutionCompleted): void
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
 * exception messages. Lifecycle sinks receive only tool name, duration, and
 * outcome so exporters can preserve the same privacy boundary.
 */
export class ToolExecutionObserver {
  private readonly byTool = new Map<string, MutableToolExecutionStats>()
  private readonly total = emptyStats()
  private readonly sinks = new Set<ToolExecutionLifecycleSink>()

  constructor(private readonly clock: Clock = performance.now.bind(performance)) {}

  /** Subscribe a metadata-only lifecycle sink. */
  addSink(sink: ToolExecutionLifecycleSink): () => void {
    this.sinks.add(sink)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.sinks.delete(sink)
    }
  }

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
    const sinks = this.startSinks(toolName)

    this.total.active += 1
    tool.active += 1

    try {
      const result = await next()
      this.finish(toolName, tool, startedAt, result.isError, sinks)
      return result
    } catch (error) {
      // A tool body is normally normalized into ToolExecutionResult by the
      // registry. A downstream around-dispatch wrapper may still throw, so the
      // observer must restore active gauges and count that terminal path too.
      this.finish(toolName, tool, startedAt, true, sinks)
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

  private startSinks(toolName: string): ToolExecutionLifecycleSink[] {
    const event = Object.freeze({ toolName })
    const accepted: ToolExecutionLifecycleSink[] = []

    for (const sink of this.sinks) {
      try {
        sink.onStart?.(event)
        accepted.push(sink)
      } catch {
        // Observability must never change tool execution semantics. If a sink
        // rejects start, omit its completion too so active gauges stay balanced.
      }
    }

    return accepted
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
    toolName: string,
    tool: MutableToolExecutionStats,
    startedAt: number,
    isError: boolean,
    sinks: readonly ToolExecutionLifecycleSink[],
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

    const event = Object.freeze({ toolName, durationMs, isError })
    for (const sink of sinks) {
      try {
        sink.onComplete?.(event)
      } catch {
        // Export failures are contained: telemetry must not fail a tool call.
      }
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
