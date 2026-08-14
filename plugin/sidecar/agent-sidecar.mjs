import { query } from '@anthropic-ai/claude-agent-sdk'
import { createSidecar, parseArgv } from './lib.mjs'

let argvOptions
try {
  argvOptions = parseArgv(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error && error.message ? error.message : String(error)}\n`)
  process.exit(1)
}

// Hermetic self-check (#239): reaching this line means the entire import
// closure loaded — lib.mjs, ../shared/tool-approval.mjs,
// ../shared/chat-attachments.mjs, and @anthropic-ai/claude-agent-sdk with its
// platform binary package. No network, no account, no query() call; the
// packaging pipeline runs this against real staged payloads to prove the
// sidecar can actually start where production resolves it.
if (argvOptions.selfCheck) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    selfCheck: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      entry: import.meta.url,
      sdkLoaded: typeof query === 'function'
    }
  })}\n`)
  process.exit(0)
}

const sidecar = createSidecar({
  queryFn: query,
  writeLine: (obj) => {
    process.stdout.write(`${JSON.stringify(obj)}\n`)
  },
  argvOptions,
  env: process.env
})

if (argvOptions.probe) {
  const exitCode = await sidecar.runProbe()
  process.exit(exitCode)
}

let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk

  let newlineIndex = buffer.indexOf('\n')
  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
    buffer = buffer.slice(newlineIndex + 1)
    sidecar.handleLine(line)
    newlineIndex = buffer.indexOf('\n')
  }
})

process.stdin.on('end', () => {
  const line = buffer.replace(/\r$/, '')
  buffer = ''
  if (line) {
    sidecar.handleLine(line)
  }
})
