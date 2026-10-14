import { expect, test } from '@playwright/test'
import { Column, fx, loadIndex, openLab, proof } from './lab'

// PLFM-9753 — query_string is accepted, and column names in it are rewritten to the
// index's internal field ids (structurally and inside the query text).
test.describe('PLFM-9753 query_string', () => {
  test.beforeEach(async ({ page }) => {
    await openLab(page)
    await expect(await loadIndex(page, 'main')).toContainText(fx.indexes.main)
  })

  test('Lucene syntax with column prefixes runs and filters', async ({ page }, testInfo) => {
    const a = new Column(page, 'A')
    const b = new Column(page, 'B')
    await a.set({ type: 'query_string' })
    await b.set({ type: 'query_string' })

    await test.step('name:feline AND NOT summary:tabby', async () => {
      await a.search('name:feline AND NOT summary:tabby')
      expect(await a.total()).toBe(fx.expect.feline_not_tabby)
      for (const n of await a.names()) expect(n).toMatch(/^Feline/)
      expect((await a.dsl()).query.query_string.query).toBe('name:feline AND NOT summary:tabby')
    })
    await test.step('grouping: (comet OR sourdough) AND NOT name:archive', async () => {
      await b.search('(comet OR sourdough) AND NOT name:archive')
      expect(await b.total()).toBe(fx.expect.comet_or_sourdough)
      for (const n of await b.names()) expect(n).toMatch(/^(Astronomy|Baking)/)
    })
    await proof(page, testInfo, 'query_string results')
  })

  test('an unknown column in the query text is rejected with a clear reason', async ({ page }, testInfo) => {
    const a = new Column(page, 'A')
    await a.set({ type: 'query_string' })
    await a.search('nosuchcol:feline')
    await expect(a.error()).toContainText("'query_string.query' references an unknown column: 'nosuchcol'")
    await proof(page, testInfo, 'unknown column rejected')
  })
})
