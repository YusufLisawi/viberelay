import { describe, expect, it } from 'vitest'
import {
  processEffortLevel,
  processReasoningEffort,
  processThinkingParameter,
  stripResidualModelSuffixes,
  stripThinkingBlocks
} from '../src/proxy/request-transformer.js'

describe('request transformer', () => {
  it('converts claude thinking suffix into thinking budget', () => {
    const result = processThinkingParameter(JSON.stringify({
      model: 'claude-sonnet-4-5-thinking-8000',
      messages: [{ role: 'user', content: 'hi' }]
    }))

    expect(result).toBeTruthy()
    const body = JSON.parse(result!.body) as { model: string, thinking: { type: string, budget_tokens: number } }
    expect(body.model).toBe('claude-sonnet-4-5')
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8000 })
  })

  it('converts claude effort suffix into output effort block', () => {
    const result = processEffortLevel(JSON.stringify({
      model: 'claude-sonnet-4-5-effort-high'
    }))

    const body = JSON.parse(result!) as { model: string, output_config: { effort: string } }
    expect(body.model).toBe('claude-sonnet-4-5')
    expect(body.output_config).toEqual({ effort: 'high' })
  })

  it('converts gpt reasoning suffix into reasoning effort', () => {
    const result = processReasoningEffort(JSON.stringify({
      model: 'gpt-5.4-reasoning-low',
      input: 'hi'
    }))

    const body = JSON.parse(result!) as { model: string, reasoning: { effort: string } }
    expect(body.model).toBe('gpt-5.4')
    expect(body.reasoning).toEqual({ effort: 'low' })
  })

  it('strips bare residual suffixes as safety net', () => {
    const result = stripResidualModelSuffixes(JSON.stringify({ model: 'claude-sonnet-4-5-thinking' }))
    expect(result).toEqual({ body: JSON.stringify({ model: 'claude-sonnet-4-5' }), suffix: 'thinking' })
  })

  it('strips thinking content blocks to avoid invalid signature retries', () => {
    const stripped = stripThinkingBlocks(JSON.stringify({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'secret', signature: 'sig' },
            { type: 'text', text: 'answer' }
          ]
        }
      ]
    }))

    const body = JSON.parse(stripped!) as { messages: Array<{ content: Array<{ type: string }> }> }
    expect(body.messages[0].content).toEqual([{ type: 'text', text: 'answer' }])
  })
})
