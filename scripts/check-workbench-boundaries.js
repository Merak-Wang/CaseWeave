async page => {
  const checks = [], assert = (ok,name) => { checks.push({name,passed:!!ok}); if(!ok) throw new Error(name) }
  const {base,id} = await page.evaluate(()=>({base:location.origin,id:new URL(location.href).searchParams.get('task')}))
  const root=base+'/api/retrieval-agent/tasks/'+id, get=async suffix=>(await page.request.get(root+suffix)).json()
  try {
    await page.setViewportSize({width:1440,height:900})
    const before=await get(''); let release, entered
    const gate=new Promise(r=>release=r), started=new Promise(r=>entered=r)
    await page.route('**/tasks/'+id+'/report?**',async route=>{const response=await route.fetch(); entered(); await gate; await route.fulfill({response})})
    await page.getByRole('tab',{name:'检索报告',exact:true}).click(); await started
    const sent=page.waitForResponse(r=>r.request().method()==='POST'&&r.url()===root)
    await page.locator('#supplement').fill('只看上海，排除北京工单'); await page.locator('#send-supplement').click()
    const receipt=await (await sent).json(); release()
    await page.waitForFunction(rev=>Number(document.getElementById('task').dataset.inputRevision) === rev,receipt.inputRevision)
    await page.unroute('**/tasks/'+id+'/report?**')
    await page.waitForFunction(()=>!document.getElementById('save-report').disabled)
    await page.locator('#reload-report').click()
    await page.waitForFunction(old=>{const t=document.getElementById('report-content').textContent;return t.includes('排除北京')&&!t.includes(old)},before.node.result.resultRevision)
    const after=await get('')
    assert(after.inputRevision===before.inputRevision+1&&after.node.result.resultRevision!==before.node.result.resultRevision,'supplement creates new authoritative result revision')
    assert(!(await page.locator('#report-content').innerText()).includes(before.node.result.resultRevision),'late prior report cannot overwrite revised scope')
    assert(await page.locator('#artifacts .card').count()===0,'old result files are withdrawn after supplement')
    // Delay a real authorized detail response, then change input via another tab.
    await page.getByRole('tab',{name:'工单结果',exact:true}).click(); await page.getByRole('button',{name:'查看依据 ↗'}).waitFor()
    let releaseDetail, detailEntered
    const detailGate=new Promise(r=>releaseDetail=r), detailStarted=new Promise(r=>detailEntered=r)
    await page.route('**/api/retrieval-agent/detail',async route=>{const response=await route.fetch(); detailEntered(); await detailGate; await route.fulfill({response})})
    await page.getByRole('button',{name:'查看依据 ↗'}).click(); await detailStarted
    const second=await page.context().newPage(); await second.goto(page.url()); await second.locator('#supplement').fill('继续只看上海，排除北京工单')
    await second.locator('#send-supplement').click(); await second.waitForFunction(()=>document.getElementById('task').dataset.inputRevision === '5')
    await page.waitForFunction(()=>document.getElementById('task').dataset.inputRevision === '5'); releaseDetail()
    await page.unroute('**/api/retrieval-agent/detail'); await second.close()
    assert(await page.locator('#evidence-panel').isHidden(),'late detail is discarded after another tab revises input')
    await page.getByRole('button',{name:'查看依据 ↗'}).waitFor()
    const current=await get(''), empty=await get('/candidates?view=confirmed&limit=50')
    // The following are explicitly presentation-only fault injections, using the real snapshot schema.
    const cases=[
      {name:'loading',status:'searching',result:false,count:0,message:'正在等待向量通道，关键词通道已取得线索'},
      {name:'single-channel-failure',status:'searching',result:false,count:0,message:'向量通道失败，关键词通道继续核查'},
      {name:'no-result',status:'completed',result:true,count:0,message:'本轮没有可确认工单'},
      {name:'resource-stop',status:'completed',result:true,count:1,message:'资源中止，本轮未完成，仅交付已确认工单'},
      {name:'snapshot-invalid',status:'snapshot_invalid',result:false,count:0,message:'来源版本已失效，请重新检索'},
      {name:'permission-blocked',status:'permission_blocked',result:false,count:0,message:'当前访问资格已失效，请重新检索'}
    ]
    for(const c of cases){
      const s=JSON.parse(JSON.stringify(current)); s.node.status=c.status; s.node.message=c.message; s.node.collectionWindow.confirmed=c.count
      if(!c.result) delete s.node.result
      else if(c.name === 'resource-stop') s.node.result.stoppingReason = 'partial'
      else if(c.name === 'no-result') s.node.result.stoppingReason = 'no_result'
      s.query='长中文业务范围与来源核查：'.repeat(8); s.node.candidates=c.count?s.node.candidates:[]
      await page.route(root,route=>route.fulfill({json:s}))
      await page.route('**/tasks/'+id+'/candidates?**',route=>route.fulfill({json:{...empty,items:c.count?empty.items:[],total:c.count}}))
      await page.reload(); await page.waitForFunction(message=>document.getElementById('process-search').textContent.includes(message),c.message)
      if(c.name === 'resource-stop') assert((await page.locator('#status').innerText()).includes('尚未完成'),'resource stop remains incomplete in the concise status')
      assert(await page.locator('#save-report').isDisabled()===!c.result,c.name+' delivery readiness')
      for(const width of [1440,1024,736,360]){
        await page.setViewportSize({width,height:900})
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),c.name+' fits '+width)
      }
      await page.screenshot({path:'output/playwright/phase8-state-'+c.name+'.png',fullPage:true})
      await page.unroute(root); await page.unroute('**/tasks/'+id+'/candidates?**')
    }
    await page.reload(); await page.getByRole('button',{name:'查看依据 ↗'}).waitFor()
    return {taskId:id,checks,presentationCases:cases.map(c=>c.name)}
  }catch(e){await page.unrouteAll({behavior:'ignoreErrors'});return {taskId:id,checks,error:String(e)}}
}
