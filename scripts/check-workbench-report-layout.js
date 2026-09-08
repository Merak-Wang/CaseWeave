async page => {
  const checks=[]
  try {
    await page.reload()
    await page.evaluate(()=>document.addEventListener('click',e=>{if(e.target.closest('button')?.textContent==='打开对应原文')window.reportClickTop=scrollY},{capture:true}))
    await page.getByRole('tab',{name:'检索报告',exact:true}).click()
    await page.getByRole('button',{name:'打开对应原文',exact:true}).first().waitFor()
    for (const width of [1440,1024,736,360]) {
      await page.setViewportSize({width,height:900})
      const passed=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)
      checks.push({name:'real report, citations and result hash fit '+width,passed})
      if(!passed) throw new Error('Horizontal report overflow at '+width)
      await page.screenshot({path:'output/playwright/phase8-real-report-'+width+'.png',fullPage:true})
      const citation=page.getByRole('button',{name:'打开对应原文',exact:true}).first()
      await citation.scrollIntoViewIfNeeded(); const top=await page.evaluate(()=>window.scrollY)
      await citation.click(); await page.locator('#detail mark').first().waitFor(); await page.keyboard.press('Escape')
      const after=await page.evaluate(()=>window.scrollY), focused=await citation.evaluate(el=>document.activeElement===el)
      const returns=Math.abs(after-top)<=2&&focused
      checks.push({name:'real report citation restores position and focus at '+width,passed:returns,top,after,focused,clickTop:await page.evaluate(()=>window.reportClickTop)})
      if(!returns)throw new Error('Report reading position lost at '+width)
    }
    await page.setViewportSize({width:1440,height:1000})
    return {url:page.url(),checks}
  }catch(e){return {checks,error:String(e)}}
}
