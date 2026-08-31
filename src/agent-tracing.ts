import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context as OtelContext,
  type Span,
  type Tracer,
} from '@opentelemetry/api'
import {
  isAgentLoopRequest,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { OTEL_TRACER_NAME } from './otel-tracing.ts'

export const AGENT_TURN_SPAN_NAME = 'dsh.agent.turn'
export const AGENT_STEP_SPAN_NAME = 'dsh.agent.step'
export const LLM_REQUEST_SPAN_NAME = 'dsh.llm.request'

const TURN_ATTRIBUTE = 'agent.turn'
const STEP_ATTRIBUTE = 'agent.step'
const OUTCOME_ATTRIBUTE = 'outcome'
const ERROR_TYPE_ATTRIBUTE = 'error.type'
const LLM_PROVIDER_ATTRIBUTE = 'llm.provider'
const LLM_MODEL_ATTRIBUTE = 'llm.model'

interface ActiveSpan {
  readonly span: Span
  readonly context: OtelContext
  readonly turn: number
  readonly step?: number
}

interface SessionTraceState {
  turn?: ActiveSpan
  step?: ActiveSpan
}

function safely(action: () => void): void {
  try {
    action()
  } catch {
    // Observability must never change Agent Runtime semantics.
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * OpenTelemetry projection of DeepSeek Harness Agent lifecycle boundaries.
 *
 * Turn and step spans are opened and closed from the durable `session/event`
 * feed. Model request spans wrap the real `llm/stream` AsyncIterable. The class
 * stores only process-local span contexts keyed by session id; session ids are
 * never exported as span attributes.
 */
export class OpenTelemetryAgentTracing {
  private readonly sessions = new Map<string, SessionTraceState>()

  constructor(private readonly tracer: Tracer = trace.getTracer(OTEL_TRACER_NAME)) {}

  /** Observe one committed durable session event. */
  onSessionEvent(session: Session, event: SessionEvent): void {
    const key = String(session.id)
    const data = recordOf(event.data)
    if (data === undefined) return

    switch (event.type) {
      case 'turn/start': {
        const turn = numberField(data, 'turn')
        if (turn === undefined) return

        this.closeSessionState(key, event.time)
        const active = this.startSpan(
          AGENT_TURN_SPAN_NAME,
          { [TURN_ATTRIBUTE]: turn },
          context.active(),
          event.time,
          turn,
        )
        if (active !== undefined) this.sessions.set(key, { turn: active })
        return
      }

      case 'step/start': {
        const turn = numberField(data, 'turn')
        const step = numberField(data, 'step')
        if (turn === undefined || step === undefined) return

        const state = this.sessions.get(key) ?? {}
        if (state.step !== undefined) this.endSpan(state.step, event.time)

        const parent = state.turn?.context ?? context.active()
        const active = this.startSpan(
          AGENT_STEP_SPAN_NAME,
          { [TURN_ATTRIBUTE]: turn, [STEP_ATTRIBUTE]: step },
          parent,
          event.time,
          turn,
          step,
        )
        state.step = active
        if (state.turn !== undefined || state.step !== undefined) this.sessions.set(key, state)
        return
      }

      case 'step/end': {
        const turn = numberField(data, 'turn')
        const step = numberField(data, 'step')
        const state = this.sessions.get(key)
        const active = state?.step
        if (active === undefined || turn !== active.turn || step !== active.step) return

        safely(() => active.span.setAttribute(OUTCOME_ATTRIBUTE, 'completed'))
        this.endSpan(active, event.time)
        state.step = undefined
        return
      }

      case 'turn/end': {
        const turn = numberField(data, 'turn')
        const state = this.sessions.get(key)
        if (state === undefined) return

        if (state.step !== undefined) {
          this.endSpan(state.step, event.time)
          state.step = undefined
        }

        if (state.turn !== undefined && turn === state.turn.turn) {
          this.applyTurnReason(state.turn.span, data['reason'])
          this.endSpan(state.turn, event.time)
        }
        this.sessions.delete(key)
        return
      }
    }
  }

  /** End any lifecycle spans still owned by a disposed live session. */
  disposeSession(session: Session): void {
    this.closeSessionState(String(session.id))
  }

  /** Return the current step context, falling back to the current turn. */
  contextForSession(sessionId: unknown): OtelContext | undefined {
    if (sessionId === undefined || sessionId === null) return undefined
    const state = this.sessions.get(String(sessionId))
    return state?.step?.context ?? state?.turn?.context
  }

  /**
   * Trace one Agent-loop model request through the real `llm/stream` seam.
   * Auxiliary one-shot LLM calls are deliberately left alone.
   */
  traceLlm(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    if (!isAgentLoopRequest(options) || options.sessionId === undefined) return next()

    const parent = this.contextForSession(options.sessionId) ?? context.active()
    let active: ActiveSpan | undefined

    try {
      active = this.startSpan(
        LLM_REQUEST_SPAN_NAME,
        {
          [LLM_PROVIDER_ATTRIBUTE]: options.provider,
          [LLM_MODEL_ATTRIBUTE]: options.model,
        },
        parent,
        undefined,
        0,
      )
    } catch {
      return next()
    }

    if (active === undefined) return next()

    let nextStarted = false
    let source: AsyncIterable<StreamChunk>

    try {
      source = context.with(active.context, () => {
        nextStarted = true
        return next()
      })
    } catch (error) {
      if (!nextStarted) {
        this.endSpan(active)
        return next()
      }
      this.markThrownError(active.span, error)
      this.endSpan(active)
      throw error
    }

    return this.wrapStream(source, active)
  }

  private wrapStream(
    source: AsyncIterable<StreamChunk>,
    active: ActiveSpan,
  ): AsyncIterable<StreamChunk> {
    const owner = this

    return (async function* tracedStream() {
      const iterator = source[Symbol.asyncIterator]()
      let sourceDone = false
      let iteratorFailed = false

      try {
        while (true) {
          let item: IteratorResult<StreamChunk>
          try {
            item = await context.with(active.context, () => iterator.next())
          } catch (error) {
            iteratorFailed = true
            throw error
          }

          if (item.done) {
            sourceDone = true
            break
          }

          owner.observeLlmChunk(active.span, item.value)
          yield item.value
        }
      } catch (error) {
        owner.markThrownError(active.span, error)
        throw error
      } finally {
        let closeError: unknown
        if (!sourceDone && !iteratorFailed && iterator.return !== undefined) {
          try {
            await context.with(active.context, () => iterator.return?.())
          } catch (error) {
            owner.markThrownError(active.span, error)
            closeError = error
          }
        }
        owner.endSpan(active)
        if (closeError !== undefined) throw closeError
      }
    })()
  }

  private observeLlmChunk(span: Span, chunk: StreamChunk): void {
    if (chunk.type !== 'finish') return

    const reason = recordOf(chunk.reason)
    const kind = stringField(reason, 'kind')
    if (kind === undefined) return

    safely(() => span.setAttribute(OUTCOME_ATTRIBUTE, kind))
    if (kind !== 'error' && kind !== 'aborted') return

    safely(() => span.setStatus({ code: SpanStatusCode.ERROR }))
    const failure = recordOf(reason?.['failure'])
    const errorType = stringField(failure, 'code')
    if (errorType !== undefined) {
      safely(() => span.setAttribute(ERROR_TYPE_ATTRIBUTE, errorType))
    }
  }

  private applyTurnReason(span: Span, reasonValue: unknown): void {
    const reason = recordOf(reasonValue)
    const kind = stringField(reason, 'kind')
    if (kind === undefined) return

    safely(() => span.setAttribute(OUTCOME_ATTRIBUTE, kind))
    if (kind !== 'error') return

    safely(() => span.setStatus({ code: SpanStatusCode.ERROR }))
    const error = recordOf(reason?.['error'])
    const errorType = stringField(error, 'code')
    if (errorType !== undefined) {
      safely(() => span.setAttribute(ERROR_TYPE_ATTRIBUTE, errorType))
    }
  }

  private markThrownError(span: Span, error: unknown): void {
    safely(() => span.setAttribute(OUTCOME_ATTRIBUTE, 'error'))
    safely(() => span.setStatus({ code: SpanStatusCode.ERROR }))

    const errorType = stringField(recordOf(error), 'code')
    if (errorType !== undefined) {
      safely(() => span.setAttribute(ERROR_TYPE_ATTRIBUTE, errorType))
    }
    // Deliberately no recordException(): message/stack are outside the privacy boundary.
  }

  private startSpan(
    name: string,
    attributes: Record<string, string | number>,
    parent: OtelContext,
    startTime: number | undefined,
    turn: number,
    step?: number,
  ): ActiveSpan | undefined {
    try {
      const span = this.tracer.startSpan(
        name,
        {
          kind: SpanKind.INTERNAL,
          attributes,
          ...(startTime === undefined ? {} : { startTime }),
        },
        parent,
      )
      return {
        span,
        context: trace.setSpan(parent, span),
        turn,
        ...(step === undefined ? {} : { step }),
      }
    } catch {
      return undefined
    }
  }

  private endSpan(active: ActiveSpan, endTime?: number): void {
    safely(() => active.span.end(endTime))
  }

  private closeSessionState(key: string, endTime?: number): void {
    const state = this.sessions.get(key)
    if (state === undefined) return
    if (state.step !== undefined) this.endSpan(state.step, endTime)
    if (state.turn !== undefined) this.endSpan(state.turn, endTime)
    this.sessions.delete(key)
  }
}
