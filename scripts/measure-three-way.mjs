/** Offline comparison of the currently supported surfaces. Commands are separate. */
import { promptSurface } from './prompt-surface.mjs'
const cases = [{ surface: 'none', tools: 0, native: 0, ptcTypescript: 0, ptcPython: 0, guidance: 0 }]
for (const name of ['retrieval', 'full']) {
 const surface = await promptSurface({ config: { surface: name } })
 cases.push({ surface: name, tools: surface.schemas.length,
  ...Object.fromEntries(Object.entries(surface.metrics).map(([key, metric]) => [key, metric.o200k_base])) })
}
console.log('Offline o200k_base plugin contribution; PTC subtracts empty preamble; no model calls.')
console.table(cases.map(row => ({ ...row, nativeWithGuidance: row.native + row.guidance,
 ptcTypescriptWithGuidance: row.ptcTypescript + row.guidance, ptcPythonWithGuidance: row.ptcPython + row.guidance })))
