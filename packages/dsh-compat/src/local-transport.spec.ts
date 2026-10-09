import {createServer} from 'node:http'
import {mkdir,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import LlmRuntime,{createUserMessage,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId} from '@deepseek-ai/dsh-session'
import {expect,it,vi} from 'vitest'
import * as compatibility from './opencode-pi-ai.js'

it('uses the trusted transport with DSH tools, zero temperature and provider token usage',async()=>{
  let received:Record<string,unknown>|undefined
  const server=createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{
    received=JSON.parse(body);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:'fixture-response',usage:{prompt_tokens:7,completion_tokens:3},
      choices:[{message:{role:'assistant',tool_calls:[{id:'call_fixture',type:'function',function:{name:'submit_result',arguments:'{"yes":true}'}}]},finish_reason:'tool_calls'}]}))
  })})
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  const baseURL=`http://127.0.0.1:${(server.address() as {port:number}).port}/exact-route`
  const folder=resolve('.cache/transport-tests');await mkdir(folder,{recursive:true})
  const path=resolve(folder,`fixture-${Date.now()}.mjs`)
  await writeFile(path,`export default {provider:'transport-fixture',labelProbabilities:false,createFetch(url){return async(_,init)=>{
    const request=JSON.parse(init.body);const response=await fetch(url,{...init,body:JSON.stringify({request})});const data=await response.json();
    const message=data.choices[0].message;message.tool_calls=message.tool_calls.map((t,index)=>({...t,index}));
    const chunks=[{model:data.model,choices:[{index:0,delta:message,finish_reason:null}]},{model:data.model,choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:data.usage}];
    return new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\\n\\n').join('')+'data: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}})
  }}}`)
  vi.stubEnv('RETRIEVAL_AGENT_MODEL_TRANSPORT_MODULE',path);vi.stubEnv('TRANSPORT_FIXTURE_KEY','fixture')
  const ctx=new Context()
  try{
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(compatibility,{providers:{'transport-fixture':{api:'openai-completions',baseURL,apiKeyEnv:'TRANSPORT_FIXTURE_KEY',models:[{id:'fixture',contextWindow:4096,maxTokens:64}]}}})
    const chunks:StreamChunk[]=[]
    for await(const chunk of ctx.llm.stream({provider:'transport-fixture',model:'fixture',temperature:0,sessionId:SessionId('fixture'),
      messages:[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'judge'}]})],tools:[{name:'submit_result',description:'Submit binary judgment',parameters:{type:'object',properties:{yes:{type:'boolean'}}}}]}))chunks.push(chunk)
    expect(received).toMatchObject({request:{temperature:0,tools:[{type:'function',function:{name:'submit_result'}}]}})
    expect(chunks.some(c=>c.type==='tool-call-delta')).toBe(true)
    expect(chunks).toContainEqual(expect.objectContaining({type:'usage',usage:expect.objectContaining({inputTokens:7,outputTokens:3})}))
    expect(chunks.at(-1)).toMatchObject({type:'finish',reason:{kind:'tool-calls'}})
  }finally{await ctx.fiber.dispose();vi.unstubAllEnvs();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}
})
