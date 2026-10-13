import { expect, it } from '@effect/vitest'
import { Schema } from 'effect'
import { continueResponse, type ResponseCheckpoint } from './ResponsesSocket.ts'

const body = {
  model: 'gpt-test',
  stream: true,
  input: [{ role: 'user', content: 'Find my notes.' }],
}
const call = { type: 'function_call', name: 'search', call_id: 'call-1', arguments: '{}' }
const output = [{ type: 'reasoning', encrypted_content: 'provider-reasoning' }, call]
const checkpoint: ResponseCheckpoint = {
  id: 'response-1',
  input: body.input,
  output,
  settings: JSON.stringify({ model: body.model, stream: body.stream }),
}
const followup = {
  ...body,
  input: [
    ...body.input,
    call,
    { type: 'function_call_output', call_id: 'call-1', output: 'Found notes.' },
    { role: 'user', content: 'Focus on yesterday.' },
  ],
} satisfies Record<string, Schema.Json>

it('continues with tool results and steering while retaining provider reasoning', () => {
  expect(continueResponse(followup, checkpoint)).toEqual({
    ...followup,
    previous_response_id: checkpoint.id,
    input: [
      { type: 'function_call_output', call_id: 'call-1', output: 'Found notes.' },
      { role: 'user', content: 'Focus on yesterday.' },
    ],
  })
})

it('sends the complete request when input, settings, or replayed output changes', () => {
  const changes = [
    { ...followup, model: 'different-model' },
    { ...followup, input: [{ role: 'user', content: 'Different context.' }, call] },
    { ...followup, input: [...body.input, { ...call, arguments: '{"query":"changed"}' }] },
  ]
  for (const changed of changes) expect(continueResponse(changed, checkpoint)).toBe(changed)
  expect(continueResponse(followup)).toBe(followup)
})

it('continues after Effect reserializes equivalent provider tool arguments', () => {
  const nativeCall = {
    ...call,
    arguments: '{ "query": "notes", "filter": { "count": 3, "kind": "user" } }',
  }
  const replayedCall = {
    ...call,
    arguments: '{"filter":{"kind":"user","count":3},"query":"notes"}',
  }
  const previous = { ...checkpoint, output: [nativeCall] }
  const result = { type: 'function_call_output', call_id: call.call_id, output: 'Found.' }
  const request = { ...body, input: [...body.input, replayedCall, result] }
  expect(continueResponse(request, previous)).toEqual({
    ...request,
    previous_response_id: previous.id,
    input: [result],
  })
  const changed = {
    ...request,
    input: [
      ...body.input,
      { ...replayedCall, arguments: '{"filter":{"kind":"user","count":4},"query":"notes"}' },
      result,
    ],
  }
  expect(continueResponse(changed, previous)).toBe(changed)
})
