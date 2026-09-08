import {spawn} from 'node:child_process'
import {mkdir,writeFile} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'

const args=Object.fromEntries(process.argv.slice(2).map(value=>{const at=value.indexOf('=');if(at<0)throw new Error('Use --name=value');return [value.slice(2,at),value.slice(at+1)]}))
const session=args.session??'workbench', scenario=args.scenario??'delivery', out=resolve(args.out??'output/phase8')
const files={inputs:'check-workbench-inputs.js',delivery:'check-workbench-browser.js',boundaries:'check-workbench-boundaries.js',scale:'check-workbench-scale.js',files:'check-workbench-files.js','report-layout':'check-workbench-report-layout.js',deployment:'check-workbench-installed.js'}
if(!/^[a-zA-Z0-9_-]+$/.test(session)||!Object.hasOwn(files,scenario))throw new Error('Invalid session or scenario')
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
let output=''
const code=await new Promise((done,reject)=>{
  const cliArgs=['--yes','--package','@playwright/cli','playwright-cli','-s='+session,'run-code','--filename=scripts/'+files[scenario]]
  // Windows needs cmd for npx.cmd; all shell arguments here are fixed or allowlisted.
  const child=spawn(process.platform==='win32'?(process.env.ComSpec??'cmd.exe'):'npx',process.platform==='win32'?['/d','/s','/c','npx '+cliArgs.join(' ')]:cliArgs,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']})
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);child.on('error',reject);child.on('exit',done)
})
await mkdir(out,{recursive:true});await writeFile(resolve(out,scenario+'-browser.log'),output)
const match=output.match(/### Result\r?\n([^\r\n]+)/), result=match?JSON.parse(match[1]):{error:'Browser CLI did not return a result'}
await writeFile(resolve(out,scenario+'-browser.json'),JSON.stringify(result,null,2))
const passed=code===0&&!result.error&&result.checks?.length>0&&result.checks.every(c=>c.passed)
console.log(JSON.stringify({scenario,passed,checks:result.checks?.length??0,error:result.error??null,output:out}))
if(!passed)process.exitCode=1
