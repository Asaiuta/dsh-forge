/** Capture registered schemas and DSH's actual native/PTC projections offline. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { apply } from '../lib/index.js'

export async function promptSurface() {
  const definitions = [], commands = [], disposers = []
  const host = {
    tools: { register: definition => { definitions.push(definition) } },
    commands: { register: command => { commands.push(command) } },
  }
  try {
    for (const dispose of apply(host)) if (typeof dispose === 'function') disposers.push(dispose)
    const sdk = process.env.DSH_FORGE_DSH_MODULES
      ? await import(pathToFileURL(`${process.env.DSH_FORGE_DSH_MODULES}/dsh-tools/lib/index.js`).href)
      : await import('@deepseek-ai/dsh-tools')
    const schemas = definitions.map(definition => sdk.ToolRuntime.prototype.schemaOf.call({}, definition, true))
    const outputs = schemas.map((schema, index) => ({ ...schema, output: definitions[index].output.schema }))
    const native = JSON.stringify(schemas)
    // Subtract the renderer's empty preamble: only this plugin's contribution.
    const ptcTypescript = sdk.renderToolsSdk(outputs)
    const ptcPython = sdk.renderToolsSdkPy(outputs)
    const emptyTypescript = sdk.renderToolsSdk([])
    const emptyPython = sdk.renderToolsSdkPy([])
    const require = createRequire(import.meta.url)
    let getEncoding
    try { ({ getEncoding } = require('js-tiktoken')) } catch { /* optional tokenizer */ }
    const tokenizers = getEncoding ? Object.fromEntries(['cl100k_base', 'o200k_base'].map(name => [name, getEncoding(name)])) : {}
    const texts = { native, ptcTypescript, ptcPython }
    const metrics = Object.fromEntries(Object.entries(texts).map(([name, value]) => {
      const empty = name === 'ptcTypescript' ? emptyTypescript : name === 'ptcPython' ? emptyPython : ''
      const bytes = Buffer.byteLength(value) - Buffer.byteLength(empty)
      return [name, { bytes, estTokens: Math.ceil(bytes / 4), ...Object.fromEntries(
        Object.entries(tokenizers).map(([name, tokenizer]) => [name, tokenizer.encode(value).length - tokenizer.encode(empty).length]),
      ) }]
    }))
    return { schemas, commands: commands.map(({ name, description }) => ({ name, description })), texts, metrics }
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
  }
}
