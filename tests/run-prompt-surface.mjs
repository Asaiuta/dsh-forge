import assert from 'node:assert/strict'
import { getEncoding } from 'js-tiktoken'
import { promptSurface, promptSdk } from '../scripts/prompt-surface.mjs'
const modules=process.env.DSH_FORGE_DSH_MODULES
const encoding=getEncoding('o200k_base')
let count=0
try {
 for(const version of ['development',...(modules?['installed']:[])]) {
  if(version==='development') delete process.env.DSH_FORGE_DSH_MODULES
  else process.env.DSH_FORGE_DSH_MODULES=modules
  const sdk=await promptSdk()
  for(const surface of ['retrieval','full']) {
   const result=await promptSurface({config:{surface}})
   assert.equal(result.surface,surface);assert.equal(result.schemas.length,surface==='full'?10:3)
   assert.equal(result.metrics.native.o200k_base,encoding.encode(result.texts.native).length)
   assert.equal(result.metrics.ptcTypescript.o200k_base,encoding.encode(result.texts.ptcTypescript).length-encoding.encode(sdk.renderToolsSdk([])).length)
   assert.equal(result.metrics.ptcPython.o200k_base,encoding.encode(result.texts.ptcPython).length-encoding.encode(sdk.renderToolsSdkPy([])).length)
   assert.ok(!('estTokens' in result.metrics.native));assert.ok(!JSON.stringify(result.outputs).includes('forgePresentation'))
   assert.match(result.texts.guidance,/Symbol known.*read with file_path=<file>#<Symbol>.*no outline first/)
   if(surface==='full') assert.match(result.texts.guidance,/todo_write.*mirrored.*do not recreate.*task_add/)
   console.log('PASS',version,surface,'real SDK projections and tokenizer counts');count++
  }
 }
 if(!modules) console.log('installed prompt SDK SKIPPED (set DSH_FORGE_DSH_MODULES)')
 console.log(`${count} prompt surface groups passed, 0 failed`)
} finally { if(modules===undefined)delete process.env.DSH_FORGE_DSH_MODULES;else process.env.DSH_FORGE_DSH_MODULES=modules }
