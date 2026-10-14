import { expect, test } from '@playwright/test'
import { Column, fx, loadIndex, openLab, proof } from './lab'

// PLFM-9970 — (1) an override entry that sets no analyzer keeps the column-type default;
// (2) every sort gets a unique trailing key, so search_after pages each row exactly once.
test.describe('PLFM-9970 analyzer precedence and sort tiebreak', () => {
  test.beforeEach(async ({ page }) => {
    await openLab(page)
    await expect(await loadIndex(page, 'main')).toContainText(fx.indexes.main)
  })

  test('an analyzer-less override entry still stems like the column default', async ({ page }, testInfo) => {
    // Both columns hold the same text ("regenerating tumors"); only probe_flagged has an
    // override entry (semantic: true, no analyzer). SCIENTIFIC stems tumors → tumor;
    // the standard analyzer the bug fell back to doesn't, so probe_flagged found 0.
    const a = new Column(page, 'A')
    const b = new Column(page, 'B')
    await a.set({ type: 'match', field: 'probe_plain' })
    await b.set({ type: 'match', field: 'probe_flagged' })
    await a.search('tumor')
    await b.search('tumor')
    expect(await a.total()).toBe(fx.expect.probe_matches)
    expect(await b.total()).toBe(fx.expect.probe_matches)
    await expect(page.locator('#compareSummary')).toContainText(
      `${fx.expect.probe_matches} of ${fx.expect.probe_matches} results in common`)
    await proof(page, testInfo, 'probe_plain vs probe_flagged')
  })

  test('match_all paged with search_after returns every row exactly once', async ({ page }, testInfo) => {
    // Every match_all hit scores the same; before the fix the cursor matched every
    // document and page two came back empty.
    const a = new Column(page, 'A')
    await page.locator('#sizeInput').fill('7')
    await a.set({ type: 'match_all' })
    await a.search('*')
    let pages = 1
    while (await a.el.locator('.next-page').count()) {
      if (!(await a.nextPage())) break
      pages++
      expect(pages).toBeLessThan(20)
    }
    await expect(a.error()).toHaveCount(0)
    expect(await a.el.locator('.hit').count()).toBe(fx.expect.total_rows)
    await expect(a.meta()).toHaveText(
      `${fx.expect.total_rows} shown · ${fx.expect.total_rows} total matches · ${Math.ceil(fx.expect.total_rows / 7)} pages`)
    await expect(a.meta()).not.toContainText('repeated')
    // The cursor's last value is the appended _row_id tiebreak.
    const cursor = (await a.dsl()).search_after
    expect(Number.isInteger(cursor.at(-1))).toBe(true)
    await proof(page, testInfo, 'all rows paged once')
  })
})
