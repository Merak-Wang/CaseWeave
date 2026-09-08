async page => {
  const checks=[], assert=(ok,name)=>{checks.push({name,passed:!!ok});if(!ok)throw new Error(name)}
  const base=await page.evaluate(()=>location.origin), id=await page.evaluate(()=>new URL(location.href).searchParams.get('task'))
  const get=async path=>(await page.request.get(base+'/api/retrieval-agent/tasks/'+id+path)).json()
  try {
    await page.setViewportSize({width:1440,height:1000}); await page.locator('#cards .card').first().waitFor()
    assert(await page.locator('#cards .card').count()===30,'1234 confirmed records render only 30 rows')
    await page.getByRole('button',{name:'下一页',exact:true}).click(); await page.waitForFunction(()=>document.querySelector('#page-status').textContent.startsWith('31–60'))
    const before=await page.locator('#cards .ticket-id').allTextContents()
    await page.getByRole('button',{name:'查看依据 ↗'}).nth(5).scrollIntoViewIfNeeded()
    const top=await page.evaluate(()=>scrollY)
    // A source read adds evidence events, but must neither reset a cursor nor move the user's scroll position.
    await page.getByRole('button',{name:'查看依据 ↗'}).nth(5).click(); await page.getByRole('button',{name:'反馈问题'}).waitFor()
    await page.keyboard.press('Escape')
    assert((await page.locator('#cards .ticket-id').allTextContents()).join()===before.join(),'source reads retain the same page')
    assert(Math.abs(await page.evaluate(()=>scrollY)-top)<2,'source reads retain scroll position')
    // Deliberately return the first click after the second click, through the actual detail HTTP route.
    const candidates=(await get('/candidates?view=confirmed&limit=60')).items.slice(30,32), savedDetails=[]; for(const c of candidates){const res=await page.request.post(base+'/api/retrieval-agent/detail',{data:{sessionId:id,retrievalId:id,candidateRefs:[c.ref],fields:['summary','problemDescription']}}); savedDetails.push(await res.json())}; let release, first=true; const gate=new Promise(r=>{release=r})
    await page.route('**/api/retrieval-agent/detail',async route=>{ if(first){first=false;await gate;await route.fulfill({json:savedDetails[0]})}else await route.fulfill({json:savedDetails[1]}) })
    await page.getByRole('button',{name:'查看依据 ↗'}).nth(0).click()
    await page.locator('#close-detail').click()
    await page.getByRole('button',{name:'查看依据 ↗'}).nth(1).click()
    await page.waitForFunction(expected=>document.querySelector('#detail-title').textContent===expected,before[1])
    await page.getByRole('button',{name:'反馈问题'}).waitFor(); release()
    await page.waitForFunction(()=>!document.querySelector('#detail').textContent.includes('正在重新核验'))
    assert(await page.locator('#detail-title').innerText()===before[1],'late first detail cannot overwrite latest selected ticket')
    await page.unroute('**/api/retrieval-agent/detail'); await page.keyboard.press('Escape')
    const state=await get(''); assert(state.node.collectionWindow.confirmed===1234,'authoritative total remains 1234')
    const artifacts=await get('/artifacts'), full=artifacts.find(a=>a.kind==='jsonl'&&a.status==='ready')
    assert(full&&full.rowCount===1234,'durable full file contains all 1234 records beyond current page')
    await page.locator('#delivery-link').click()
    const save=page.waitForEvent('download');await page.getByRole('button',{name:'保存 JSONL',exact:true}).click();await(await save).saveAs('output/phase8/scale-full.jsonl')
    const manifest=await get('/artifacts/'+full.id+'/manifest')
    assert(manifest.rowCount===1234&&manifest.resultRevision===state.node.result.resultRevision,'full download manifest and frozen result agree')
    await page.screenshot({path:'output/playwright/phase8-scale-page2.png',fullPage:true})
    return {taskId:id,checks,artifact:full,scrollBefore:top}
  }catch(e){return{taskId:id,checks,error:String(e)}}
}
