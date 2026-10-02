import { expect, test } from 'claude-code/testing'
import { resolveLimit } from '../hooks/register.js'

test('denies a 60KB Write with a reason mentioning Edit', async ($, on) => {
  const content = 'a'.repeat(60 * 1024)
  const result = await $.tool.call({ tool: 'Write', file_path: 'x.txt', content })
  expect(result.deny).toBeDefined()
  expect(result.deny).toMatch(/Edit/)
})

test('passes a 10KB Write through unchanged', async ($, on) => {
  on('tool.call', ($, e) => ({ result: e }))
  const content = 'a'.repeat(10 * 1024)
  const result = await $.tool.call({ tool: 'Write', file_path: 'x.txt', content })
  expect(result.result).toMatchObject({ tool: 'Write', file_path: 'x.txt', content })
})

test('passes exactly 51200 bytes', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const content = 'a'.repeat(51200)
  const result = await $.tool.call({ tool: 'Write', file_path: 'x.txt', content })
  expect(result).toEqual({ result: 'ok' })
})

test('denies 51201 bytes', async ($, on) => {
  const content = 'a'.repeat(51201)
  const result = await $.tool.call({ tool: 'Write', file_path: 'x.txt', content })
  expect(result.deny).toBeDefined()
})

test('denies multibyte content under the character limit but over the byte limit', async ($, on) => {
  // e-acute (U+00E9) is 2 bytes in UTF-8; 26,000 of them is 52,000 bytes but 26,000 chars
  const content = 'é'.repeat(26000)
  const result = await $.tool.call({ tool: 'Write', file_path: 'x.txt', content })
  expect(result.deny).toBeDefined()
})

test('passes through when content is missing', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const result = await $.tool.call({ tool: 'Write', file_path: 'x.txt' })
  expect(result).toEqual({ result: 'ok' })
})

test('does not intercept Edit calls', async ($, on) => {
  on('tool.call', () => ({ result: 'edit answered' }))
  const result = await $.tool.call({ tool: 'Edit', file_path: 'x.txt', old_string: 'a', new_string: 'b' })
  expect(result).toEqual({ result: 'edit answered' })
})

test('does not intercept Bash calls', async ($, on) => {
  on('tool.call', () => ({ result: 'bash answered' }))
  const result = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(result).toEqual({ result: 'bash answered' })
})

test('configured maxWriteBytes passes exactly 10240', { options: { maxWriteBytes: 10240 } }, async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const content = 'a'.repeat(10240)
  const result = await $.tool.call({ tool: 'Write', file_path: 'x.txt', content })
  expect(result).toEqual({ result: 'ok' })
})

test('configured maxWriteBytes denies 10241', { options: { maxWriteBytes: 10240 } }, async ($, on) => {
  const content = 'a'.repeat(10241)
  const result = await $.tool.call({ tool: 'Write', file_path: 'x.txt', content })
  expect(result.deny).toBeDefined()
  expect(result.deny).toMatch(/10240-byte limit/)
})

test('resolveLimit: empty options falls back to default with a reason', () => {
  expect(resolveLimit(undefined).limit).toBe(51200)
  expect(resolveLimit(undefined).reason).toBeDefined()
  expect(resolveLimit({}).limit).toBe(51200)
  expect(resolveLimit({}).reason).toBeDefined()
})

test('resolveLimit: invalid values fall back with a reason', () => {
  for (const bad of [0, -5, 'abc', 1.5, 1e12, NaN, Infinity]) {
    const { limit, reason } = resolveLimit({ maxWriteBytes: bad })
    expect(limit).toBe(51200)
    expect(reason).toBeDefined()
  }
})

test('resolveLimit: valid configured value is used as-is', () => {
  expect(resolveLimit({ maxWriteBytes: 10240 })).toEqual({ limit: 10240, reason: null })
})
