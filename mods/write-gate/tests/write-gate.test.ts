import { expect, test } from 'claude-code/testing'

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
