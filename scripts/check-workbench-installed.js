async page => {
  const checks = [], check = (passed, name) => { checks.push({ name, passed: Boolean(passed) }); if (!passed) throw new Error(name) }
  const { base, id } = await page.evaluate(() => ({ base: location.origin, id: new URL(location.href).searchParams.get('task') }))
  const get = async suffix => { const r = await page.request.get(base + '/api/retrieval-agent/tasks/' + id + suffix); if (r.status() !== 200) throw new Error('HTTP ' + r.status()); return r.json() }
  try {
    const before = await get('')
    check(before.node.collectionWindow.confirmed === 1, 'independent ESFT task has exactly one confirmed result')
    await page.getByRole('tab', { name: '工单结果', exact: true }).click()
    await page.getByRole('button', { name: '查看依据 ↗' }).waitFor()
    check((await page.locator('#cards .ticket-id').allTextContents()).join() === 'ESFT-SUMMARY-TRAIN-024783', 'confirmed ID matches independently inspected source')
    for (const width of [1440, 1024, 736, 360]) {
      await page.setViewportSize({ width, height: 900 })
      await page.getByRole('button', { name: '查看依据 ↗' }).click()
      await page.locator('#detail mark').first().waitFor()
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'evidence has no horizontal overflow at ' + width)
      await page.screenshot({ path: 'output/playwright/github-clean-evidence-' + width + '.png', fullPage: true })
      await page.keyboard.press('Escape')
      check(await page.getByRole('button', { name: '查看依据 ↗' }).evaluate(el => el === document.activeElement), 'evidence returns keyboard focus at ' + width)
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.locator('#delivery-link').click()
    await page.locator('#template').selectOption('full')
    await page.getByRole('button', { name: '生成 JSONL', exact: true }).click()
    const save = page.getByRole('button', { name: '保存 JSONL', exact: true }).last()
    await save.waitFor({ timeout: 30000 })
    const downloaded = page.waitForEvent('download'); await save.click()
    await (await downloaded).saveAs('output/playwright/github-clean-confirmed.jsonl')
    const artifact = (await get('/artifacts')).find(a => a.kind === 'jsonl' && a.status === 'ready')
    const response = await page.request.get(base + '/api/retrieval-agent/tasks/' + id + '/artifacts/' + artifact.id + '/content')
    const rows = (await response.text()).trim().split('\n').map(JSON.parse)
    check(rows.length === 1 && rows[0].ticketId === 'ESFT-SUMMARY-TRAIN-024783' && rows[0].resultRevision === before.node.result.resultRevision, 'browser download contains the complete confirmed set and result version')
    await page.getByRole('button', { name: '关闭下载', exact: true }).click()
    await page.getByRole('tab', { name: '检索报告', exact: true }).click()
    await page.getByRole('button', { name: '打开对应原文', exact: true }).first().waitFor()
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 900 })
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'report fits at ' + width)
      await page.screenshot({ path: 'output/playwright/github-clean-report-' + width + '.png', fullPage: true })
    }
    await page.getByRole('tab', { name: '工单结果', exact: true }).click()
    const second = await page.context().newPage(); let posts = 0
    second.on('request', r => { if (r.method() === 'POST') posts++ })
    await second.goto(page.url()); await second.locator('#cards .ticket-id').waitFor()
    check(await second.locator('#cards .ticket-id').innerText() === 'ESFT-SUMMARY-TRAIN-024783' && posts === 0, 'second tab restores without submitting work')
    await second.close(); await page.reload(); await page.locator('#cards .ticket-id').waitFor()
    await page.context().setOffline(true); await page.context().setOffline(false)
    const restored = await get('')
    check(restored.inputRevision === before.inputRevision && restored.commands.length === before.commands.length, 'refresh and reconnection retain one task and command history')
    return { taskId: id, checks }
  } catch (error) { return { taskId: id, checks, error: String(error) } }
}
