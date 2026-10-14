import { expect, test } from '@playwright/test'
import { Column, fx, loadIndex, openLab, proof } from './lab'

// PLFM-9974 — hybrid queries blend keyword and semantic relevance into one ranked set,
// with row-level access applied to every clause.
test.describe('PLFM-9974 hybrid query', () => {
  test('semantic finds by meaning what keyword cannot; hybrid blends both', async ({ page }, testInfo) => {
    await openLab(page)
    await loadIndex(page, 'main')
    const a = new Column(page, 'A')
    const b = new Column(page, 'B')

    await test.step('"kitten" — keyword: nothing; semantic: the feline rows', async () => {
      // "kitten" appears nowhere in the corpus.
      await a.set({ type: 'best_fields' })
      await b.set({ type: 'semantic' })
      await a.search('kitten')
      await b.search('kitten')
      await expect(a.el.locator('.empty')).toHaveText('No results.')
      for (const n of (await b.names()).slice(0, 3)) expect(n).toMatch(/^Feline/)
      await proof(page, testInfo, 'keyword vs semantic')
    })
    await test.step('hybrid "tabby kitten" — one ranked set led by the keyword-and-meaning match', async () => {
      await a.set({ type: 'hybrid_semantic', keywordType: 'best_fields', pipelineSource: 'inline', semanticWeight: '0.5' })
      await a.search('tabby kitten')
      await expect(a.error()).toHaveCount(0)
      const names = await a.names()
      expect(new Set(names).size).toBe(names.length)
      for (const n of names.slice(0, 3)) expect(n).toMatch(/^Feline/)
      await proof(page, testInfo, 'hybrid blend')
    })
  })

  test('an index without vectors: semantic-only is rejected, the neural leg of a hybrid is dropped', async ({ page }, testInfo) => {
    await openLab(page)
    await loadIndex(page, 'novec')
    const a = new Column(page, 'A')
    const b = new Column(page, 'B')
    await a.set({ type: 'semantic' })
    await b.set({ type: 'hybrid_semantic', keywordType: 'best_fields' })
    await a.search('kitten')
    await b.search('feline')
    await expect(a.error()).toContainText('this search index has no semantic field')
    expect(await b.total()).toBe(fx.expect.feline_rows)
    await proof(page, testInfo, 'no vectors')
  })

  test.describe('row-level access', () => {
    test.skip(!fx.indexes.acl, 'setup_fixtures.py ran with --skip-acl')
    const { public: pub, private: priv } = fx.acl_rows ?? {}

    for (const [who, anonymous, expected] of [['owner', false, pub + priv], ['anonymous', true, pub]] as const) {
      test(`${who} sees ${expected} rows, for match_all and for every hybrid clause`, async ({ page }, testInfo) => {
        await openLab(page, { anonymous })
        await expect(await loadIndex(page, 'acl')).toContainText(fx.indexes.acl)
        const a = new Column(page, 'A')
        const b = new Column(page, 'B')
        await a.set({ type: 'match_all' })
        await b.set({ type: 'hybrid_semantic', keywordType: 'best_fields' })
        await a.search('*')
        await b.search('feline kitten')
        expect(await a.total()).toBe(expected)
        const hybridNames = await b.names()
        if (anonymous) for (const n of hybridNames) expect(n).not.toMatch(/^Private/)
        else expect(hybridNames.some((n) => n.startsWith('Private'))).toBe(true)
        await proof(page, testInfo, `${who} view`)
      })
    }
  })
})
