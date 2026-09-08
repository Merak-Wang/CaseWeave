async page => {
  const checks=[], assert=(ok,name)=>{checks.push({name,passed:!!ok});if(!ok)throw new Error(name)}
  const {base,id}=await page.evaluate(()=>({base:location.origin,id:new URL(location.href).searchParams.get('task')})),root=base+'/api/retrieval-agent/tasks/'+id
  try{
    await page.locator('#delivery-link').click()
    await page.getByRole('button',{name:'生成 CSV',exact:true}).click()
    const row=page.locator('#artifacts .card').filter({hasText:'CSV'});await row.getByRole('button',{name:'保存 CSV',exact:true}).waitFor()
    const list=await(await page.request.get(root+'/artifacts')).json(),csv=list.find(d=>d.kind==='csv'&&d.status==='ready')
    let downloads=0;const track=()=>downloads++;page.on('download',track)
    await page.route(root+'/artifacts/'+csv.id+'/content',async route=>{const response=await route.fetch();await route.fulfill({response,body:'corrupted-content'})})
    await row.getByRole('button',{name:'保存 CSV',exact:true}).click();await page.locator('#delivery-error').waitFor()
    assert(downloads===0&&(await page.locator('#delivery-error').innerText()).includes('哈希'),'corrupt artifact bytes cannot start a browser save')
    await page.unroute(root+'/artifacts/'+csv.id+'/content');page.off('download',track)
    const samples=['queued','failed','expired'].map((status,i)=>({...csv,id:'presentation-'+i,status,error:status==='failed'?'受控故障：读取来源失败':null}))
    await page.route(root+'/artifacts',route=>route.fulfill({json:samples}))
    await page.reload();await page.locator('#delivery-link').click();await page.getByRole('button',{name:'重试生成',exact:true}).waitFor()
    assert((await page.locator('#artifacts').innerText()).includes('已排队')&&(await page.locator('#artifacts').innerText()).includes('已到期'),'queued, failed and expired files display their actual status fields')
    assert(await page.locator('#artifacts').getByRole('button',{name:'保存 CSV',exact:true}).count()===0,'unready artifacts have no save control')
    await page.setViewportSize({width:360,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'failed artifacts fit narrow screen')
    await page.screenshot({path:'output/playwright/phase8-artifact-states.png',fullPage:true})
    await page.unroute(root+'/artifacts');await page.reload();return {taskId:id,checks,presentationOnly:['queued','failed','expired']}
  }catch(e){await page.unrouteAll({behavior:'ignoreErrors'});return {taskId:id,checks,error:String(e)}}
}
