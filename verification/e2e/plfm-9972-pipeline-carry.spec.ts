import { expect, test } from '@playwright/test'
import { Column, fx, loadIndex, openLab, proof } from './lab'

// PLFM-9972 (and PLFM-9971's NamedSearchPipeline as the thing referenced) — a query's
// pipeline comes from the request (inline or $ref), else the index's SearchConfiguration
// default, else the system default; saved weights are trimmed to the clauses sent.
//
// verify-main's configuration defaults to `keyword_only` (weights [1.0, 0.0]).
test.describe('PLFM-9972 search pipeline carry', () => {
  test.beforeEach(async ({ page }) => {
    await openLab(page)
  })

  test("the index's default pipeline applies when the request sends none, and a request $ref beats it", async ({ page }, testInfo) => {
    await loadIndex(page, 'main')
    const a = new Column(page, 'A')
    const b = new Column(page, 'B')
    const hybrid = { type: 'hybrid_semantic', keywordType: 'best_fields' }

    await test.step('A: index default · B: $ref keyword_only → identical ranking and scores', async () => {
      await a.set({ ...hybrid, pipelineSource: 'default' })
      await b.set({ ...hybrid, pipelineSource: 'ref', pipelineRef: fx.pipelines.keyword_only })
      await a.search('sourdough starter')
      await b.search('sourdough starter')
      expect('search_pipeline' in (await a.dsl())).toBe(false)
      expect((await b.dsl()).search_pipeline).toEqual({ $ref: fx.pipelines.keyword_only })
      expect(await a.names()).toEqual(await b.names())
      expect(await a.scores()).toEqual(await b.scores())
      await proof(page, testInfo, 'index default == keyword_only')
    })
    await test.step('B: $ref semantic_only → the request pipeline wins, scores change', async () => {
      await b.set({ pipelineRef: fx.pipelines.semantic_only })
      await b.search('sourdough starter')
      await expect(b.error()).toHaveCount(0)
      expect(await b.scores()).not.toEqual(await a.scores())
      await proof(page, testInfo, 'request $ref overrides index default')
    })
  })

  test('saved weights that trim to nothing are rejected, not silently zeroed', async ({ page }, testInfo) => {
    // A semantic-only query sends one clause, at position 0; semantic_only weights that
    // position 0.0, so the kept weights can't be rescaled to 1.0.
    await loadIndex(page, 'main')
    const a = new Column(page, 'A')
    await a.set({ type: 'semantic', pipelineSource: 'ref', pipelineRef: fx.pipelines.semantic_only })
    await a.search('kitten')
    await expect(a.error()).toContainText('sum to 0, leaving no way to weight them')
    await proof(page, testInfo, 'trimmed weights rejected')
  })

  test('a $ref to a pipeline that does not exist is rejected', async ({ page }, testInfo) => {
    await loadIndex(page, 'main')
    const a = new Column(page, 'A')
    await a.set({ type: 'hybrid_semantic', pipelineSource: 'ref', pipelineRef: `${fx.organization}-no_such_pipeline` })
    await a.search('kitten')
    await expect(a.error()).toContainText('names a search pipeline that does not exist')
    await proof(page, testInfo, 'unknown $ref rejected')
  })

  test('with no request or index pipeline, the system default runs — no rejection', async ({ page }, testInfo) => {
    // verify-novec has no SearchConfiguration at all.
    await loadIndex(page, 'novec')
    const a = new Column(page, 'A')
    await a.set({ type: 'hybrid_semantic', keywordType: 'best_fields', pipelineSource: 'default' })
    await a.search('feline')
    await expect(a.error()).toHaveCount(0)
    expect(await a.total()).toBe(fx.expect.feline_rows)
    await proof(page, testInfo, 'system default pipeline')
  })
})
