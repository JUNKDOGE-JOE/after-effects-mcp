import { query } from '@anthropic-ai/claude-agent-sdk'
import { createSidecar, parseArgv } from './lib.mjs'

let argvOptions
try {
  argvOptions = parseArgv(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error && error.message ? error.message : String(error)}\n`)
  process.exit(1)
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
