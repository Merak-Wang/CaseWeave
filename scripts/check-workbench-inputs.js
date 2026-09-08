async page => {
  const checks = [], assert = (ok, name) => { checks.push({name, passed:!!ok}); if (!ok) throw new Error(name) }
  let received, attempts = [], lost = true; const timing = {}
  try {
    await page.setViewportSize({width:1440,height:900})
    await page.route('**/api/retrieval-agent/tasks', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      attempts.push(route.request().postDataJSON().operationId)
      const response = await route.fetch(); received = await response.json()
      if (lost) { lost = false; await route.abort('failed') } else await route.fulfill({response})
    })
    await page.getByRole('textbox',{name:'描述需要查找的工单'}).fill('查找副卡解绑故障工单')
    await page.getByRole('button',{name:'开始检索'}).click()
    await page.getByRole('button',{name:'重试提交'}).waitFor()
    await page.getByRole('button',{name:'重试提交'}).click()
    await page.locator('#question').waitFor()
    assert(attempts.length === 2 && attempts[0] === attempts[1], 'lost query receipt retries same operationId')
    const {base,id} = await page.evaluate(()=>({base:location.origin,id:new URL(location.href).searchParams.get('task')}))
    const get = async suffix => (await page.request.get(base+'/api/retrieval-agent/tasks/'+id+suffix)).json()
    assert(received.taskId === id && (await get('')).commands.length === 1, 'lost receipt creates one durable task and one command')
    const question = (await get('')).question.id
    const second = await page.context().newPage(); await second.goto(page.url()); await second.locator('#question').waitFor()
    await page.goto(base+'/retrieval'); await page.goto(base+'/retrieval?task='+id); await page.locator('#question').waitFor()
    assert((await get('')).question.id === question, 'leaving and reopening preserves unanswered question')
    const answerRequest = page.waitForRequest(r=>r.method()==='POST' && r.url().endsWith('/tasks/'+id))
    const answerResponse = page.waitForResponse(r=>r.request().method()==='POST' && r.url().endsWith('/tasks/'+id))
    timing.answerStarted = Date.now()
    await page.locator('#supplement').fill('只看上海'); await page.locator('#send-supplement').click()
    const answer = (await answerRequest).postDataJSON()
    await answerResponse; timing.answerReceiptMs = Date.now() - timing.answerStarted
    assert(answer.kind === 'answer' && answer.questionId === question, 'composer answer is bound to original questionId')
    await page.getByRole('button',{name:'查看依据 ↗'}).waitFor()
    await second.locator('#cards .ticket-id').waitFor()
    assert((await second.locator('#task').getAttribute('data-input-revision')) === '2', 'second tab receives revised input receipt without reload')
    await second.close()
    await page.getByRole('button',{name:'查看依据 ↗'}).click(); await page.locator('#detail mark').first().waitFor()
    await page.getByRole('button',{name:'反馈问题'}).click()
    await page.locator('#feedback-relevance').selectOption('unrelated'); await page.locator('#feedback-text').fill('我认为这条不相关，请复核原文，不改变上海范围')
    const feedbackResponse = page.waitForResponse(r=>r.request().method()==='POST' && r.url().endsWith('/tasks/'+id)); timing.feedbackStarted = Date.now()
    await page.locator('#send-feedback').click(); await feedbackResponse; timing.feedbackReceiptMs = Date.now() - timing.feedbackStarted
    await page.getByRole('button',{name:'查看依据 ↗'}).waitFor()
    await page.waitForFunction(()=>document.getElementById('receipt').textContent.includes('反馈已处理'))
    const reviewed = await get('')
    assert(reviewed.feedback.at(-1).status === 'reviewed' && reviewed.node.collectionWindow.confirmed === 1, 'optional mistaken feedback has evidence disposition and does not directly exclude')
    await page.screenshot({path:'output/playwright/phase8-inputs.png',fullPage:true})
    return {taskId:id,checks,timing}
  } catch(e) { return {checks,error:String(e)} }
}
