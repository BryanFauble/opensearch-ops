import { expect, test } from '@playwright/test'
import { Column, fx, loadIndex, openLab, proof } from './lab'

// PLFM-9973 — columns flagged `semantic` are embedded into one vector per row at build
// time. A failed build only surfaces to a client as the reason a query is refused, which
// is what the index status line shows on load.
test.describe('PLFM-9973 semantic columns', () => {
  test.beforeEach(async ({ page }) => {
    await openLab(page)
  })

  test('flagging a non-embeddable column fails the build with a clear message', async ({ page }, testInfo) => {
    const status = await loadIndex(page, 'badtype')
    await expect(status).toContainText("Column 'year' is of type INTEGER and cannot be flagged 'semantic'")
    await proof(page, testInfo, 'INTEGER column rejected')
  })

  test('a semantic source over 50,000 rows fails the build', async ({ page }, testInfo) => {
    test.skip(!fx.indexes.ceiling, 'run setup_fixtures.py --row-ceiling to build this fixture')
    const status = await loadIndex(page, 'ceiling')
    await expect(status).toContainText('would exceed maximum of 50000 rows. Row count: 50001')
    await proof(page, testInfo, 'row ceiling')
  })

  test('a row past the 8,000-token cap is still embedded and found by meaning', async ({ page }, testInfo) => {
    await loadIndex(page, 'main')
    const a = new Column(page, 'A')
    await a.set({ type: 'semantic' })
    await a.search('comet sighting recorded in an observatory logbook')
    expect(await a.names()).toContain('Archive logbook record')
    await proof(page, testInfo, 'over-cap row found')
  })

  test('the embedded text and vector are never returned on a hit', async ({ page }, testInfo) => {
    await loadIndex(page, 'main')
    await page.locator('#sizeInput').fill('50')
    const a = new Column(page, 'A')
    await a.set({ type: 'match_all' })
    await a.search('*')
    const fields = new Set(await a.el.locator('.hit-detail .field-name').allTextContents())
    expect(fields).toContain('summary')
    expect([...fields].filter((f) => /semantic/i.test(f))).toEqual([])
    await a.el.locator('.hit-expand').first().click()
    await proof(page, testInfo, 'hit fields')
  })
})
