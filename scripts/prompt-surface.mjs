/** Capture registered schemas and DSH's actual native/PTC projections offline. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

export async function promptSurface({ config, plugin, visibleNames } = {}) {
  const { apply } = await import(plugin ? pathToFileURL(path.resolve(plugin)).href : new URL('../lib/index.js', import.meta.url).href)
  const definitions = [], scoped = [], commands = [], disposers = [], sections = []
  const agent = { ctx: { tools: { register(definition) { scoped.push(definition); return () => {} } } } }
  const agents = { list: () => [agent] }
  const allowed = visibleNames === undefined ? undefined : new Set(visibleNames)
  const host = {
    tools: {
      register: definition => { definitions.push(definition) },
      get: (name, scope) => allowed && !allowed.has(name) ? undefined
        : (scope === agent.ctx ? scoped.find(d => d.name === name) : undefined) ?? definitions.find(d => d.name === name),
    },
    commands: { register: command => { commands.push(command) } },
    systemPrompt: { section(section) { sections.push(section); return () => {} } },
    get: name => name === 'agents' ? agents : undefined,
    on: () => () => {},
  }
  try {
    for (const dispose of apply(host, config)) if (typeof dispose === 'function') disposers.push(dispose)
    const visible = [...definitions, ...scoped].filter(d => !allowed || allowed.has(d.name))
    const sdk = process.env.DSH_FORGE_DSH_MODULES
      ? await import(pathToFileURL(`${process.env.DSH_FORGE_DSH_MODULES}/dsh-tools/lib/index.js`).href)
      : await import('@deepseek-ai/dsh-tools')
    const schemas = visible.map(definition => sdk.ToolRuntime.prototype.schemaOf.call({}, definition, true))
    const outputs = schemas.map((schema, index) => ({ ...schema, output: visible[index].output.schema }))
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
    const renderedSections = sections.map(section => ({ name: section.name, order: section.order,
      text: typeof section.text === 'function' ? section.text({ scope: agent.ctx }) : section.text }))
    const guidance = renderedSections.map(section => section.text).filter(Boolean).join('\n\n')
    const texts = { native, ptcTypescript, ptcPython, guidance }
    const metrics = Object.fromEntries(Object.entries(texts).map(([name, value]) => {
      const empty = name === 'ptcTypescript' ? emptyTypescript : name === 'ptcPython' ? emptyPython : ''
      const bytes = Buffer.byteLength(value) - Buffer.byteLength(empty)
      return [name, { bytes, estTokens: Math.ceil(bytes / 4), ...Object.fromEntries(
        Object.entries(tokenizers).map(([name, tokenizer]) => [name, tokenizer.encode(value).length - tokenizer.encode(empty).length]),
      ) }]
    }))
    return { registration: config?.registration ?? 'additive', sdk: process.env.DSH_FORGE_DSH_MODULES ?? 'development dependency',
      schemas, sections: renderedSections, commands: commands.map(({ name, description }) => ({ name, description })), texts, metrics }
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
  }
}
