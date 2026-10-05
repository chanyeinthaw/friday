import { describe, expect, it } from 'vitest'
import { cacheOptChatPayload, cacheOptChatResponses, splitOptChatView } from './OptChatCache.ts'

describe('OptChat cache layout', () => {
  it('marks Responses prefixes while preserving encrypted reasoning across steering', () => {
    const pieces = ['<chat>\nold\n', 'recent\n</chat>']
    const encrypted = { type: 'reasoning', encrypted_content: 'opaque signed content', summary: [] }
    const input = {
      store: true,
      reasoning: { effort: 'medium', context: 'current_turn' },
      prompt_cache_options: { mode: 'explicit', ttl: '30m' },
      input: [
        { role: 'user', content: pieces.map((text) => ({ type: 'input_text', text })) },
        encrypted,
        { role: 'user', content: [{ type: 'input_text', text: 'steering' }] },
      ],
    }
    const transformed = cacheOptChatResponses(input, pieces)
    expect(transformed.store).toBe(false)
    expect(transformed.reasoning).toEqual({ effort: 'medium', context: 'all_turns' })
    expect(transformed).toHaveProperty('prompt_cache_options', { mode: 'implicit', ttl: '30m' })
    expect(transformed).toHaveProperty('input', [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: pieces[0], prompt_cache_breakpoint: { mode: 'explicit' } },
          { type: 'input_text', text: pieces[1] },
        ],
      },
      encrypted,
      { role: 'user', content: [{ type: 'input_text', text: 'steering' }] },
    ])
    const older = cacheOptChatResponses({ input: [], reasoning: { effort: 'low' } }, pieces)
    expect('prompt_cache_options' in older).toBe(false)
  })
  it('preserves the view exactly and keeps old marked prefixes unchanged after appending', () => {
    const view = `<chat>\n${Array.from({ length: 240 }, (_, id) => `${id}+1|${'decision '.repeat(60)}\n`).join('')}</chat>`
    const pieces = splitOptChatView(view)
    expect(pieces).toHaveLength(4)
    expect(pieces.join('')).toBe(view)
    expect(pieces.slice(0, -1).every((piece) => piece.endsWith('\n'))).toBe(true)
    expect(
      splitOptChatView(view.replace('</chat>', '240+1|new decision\n</chat>')).slice(0, 3),
    ).toEqual(pieces.slice(0, 3))
    expect(splitOptChatView('<chat>\nshort\n</chat>')).toEqual(['<chat>\nshort\n</chat>'])
  })
  it('uses at most four short-lived marks while preserving tools and signed reasoning', () => {
    const pieces = ['<chat>\nold\n', 'middle\n', 'recent\n', 'latest\n</chat>']
    const signature = { type: 'thinking', thinking: 'opaque', signature: 'signed' }
    const tools = [
      {
        name: 'zoom',
        input_schema: { type: 'object' },
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]
    const transformed = cacheOptChatPayload(
      {
        system: [{ type: 'text', text: 'constant', cache_control: { type: 'ephemeral' } }],
        tools,
        messages: [
          {
            role: 'user',
            content: [
              ...pieces.map((text) => ({ type: 'text', text })),
              { type: 'text', text: 'new input' },
            ],
          },
          { role: 'assistant', content: [signature] },
          {
            role: 'user',
            content: [
              { type: 'tool_result', content: 'done', cache_control: { type: 'ephemeral' } },
            ],
          },
        ],
      },
      pieces,
    )
    expect(transformed).toEqual({
      system: [{ type: 'text', text: 'constant' }],
      tools: [{ name: 'zoom', input_schema: { type: 'object' } }],
      cache_control: { type: 'ephemeral' },
      messages: [
        {
          role: 'user',
          content: [
            ...pieces.map((text, index) =>
              index < 3
                ? { type: 'text', text, cache_control: { type: 'ephemeral' } }
                : { type: 'text', text },
            ),
            { type: 'text', text: 'new input' },
          ],
        },
        { role: 'assistant', content: [signature] },
        { role: 'user', content: [{ type: 'tool_result', content: 'done' }] },
      ],
    })
  })
})
