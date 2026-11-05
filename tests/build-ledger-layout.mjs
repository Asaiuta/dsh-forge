import { build } from 'esbuild'
import { readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
const host = process.env.DSH_FORGE_NATIVE_MODULES
const react = process.env.DSH_FORGE_REACT_MODULES
if (!host || !react) throw new Error('Set DSH_FORGE_NATIVE_MODULES and DSH_FORGE_REACT_MODULES to local module directories')
const nativeDir=path.join(host,'@deepseek-ai/dsh-client-ui-primitives/lib')
const source=readFileSync(path.join(nativeDir,'index.js'),'utf8')
function section(start) { const i=source.indexOf(start); if(i<0)throw new Error('Missing native symbol '+start); const end=source.indexOf('//#endregion',i);if(end<0)throw new Error('Missing native section');return source.slice(i,end) }
const native=[
 "import {jsx,jsxs} from 'react/jsx-runtime'; import {forwardRef} from 'react'; import clsx from 'clsx';",
 ...[['css$3','Button'],['css$4','Pill'],['css$5','SegmentedTabs'],['css$11','Input']].map(([name,file])=>`import ${name} from ${JSON.stringify(path.join(nativeDir,file+'.module.css').replaceAll('\\','/'))};`),
 section('const Button = forwardRef('),section('function Pill('),section('function SegmentedTabs('),section('const Input = forwardRef('),'export {Button,Input,SegmentedTabs};'
].join('\n')
mkdirSync('.tmp-analysis/ledger-layout',{recursive:true})
await build({stdin:{contents:`import React from 'react'; import {createRoot} from 'react-dom/client'; import {LedgerTab} from './src/client/ledger-tab'; import {mountStyles} from './src/client/styles'; mountStyles();
// When the page asks for delegation, hand the tab a fresh opener on EVERY render
// — the exact shape that used to loop forever once better-sidebar's synchronous
// store reduce re-rendered us.
const props={scope:{cwd:'/fixture'},visible:true};
if(window.__FORGE_DELEGATE===true){ props.openGitTab=()=>{ window.__forgeOpenCalls=(window.__forgeOpenCalls||0)+1; return true } }
createRoot(document.getElementById('root')).render(React.createElement(LedgerTab,props));`,resolveDir:process.cwd(),loader:'tsx'},outfile:'.tmp-analysis/ledger-layout/app.js',bundle:true,format:'iife',platform:'browser',jsx:'automatic',loader:{'.css':'local-css'},alias:{react:path.join(react,'react'),'react-dom':path.join(react,'react-dom')},nodePaths:[host,react],plugins:[{name:'native-subset',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'native-controls',namespace:'native'}));b.onLoad({filter:/.*/,namespace:'native'},()=>({contents:native,loader:'js',resolveDir:nativeDir}))}}]})
console.log('Built browser fixture with exact locally installed native control implementations and CSS; full host is not under test.')
