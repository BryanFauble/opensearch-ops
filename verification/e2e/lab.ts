import { expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Written by setup/setup_fixtures.py — the synIDs, pipeline names and expected counts.
export const fx = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures.json', import.meta.url)), 'utf8'))

// The playground is anonymous unless given a token; the fixture objects are private.
function synapseToken(): string {
  if (process.env.SYNAPSE_AUTH_TOKEN) return process.env.SYNAPSE_AUTH_TOKEN
  const m = readFileSync(`${homedir()}/.synapseConfig`, 'utf8').match(/^\s*authtoken\s*=\s*(\S+)/m)
  if (!m) throw new Error('Set SYNAPSE_AUTH_TOKEN, or authtoken in ~/.synapseConfig')
  return m[1]
}

// Point the Search Lab at repo-staging (what the Environment picker + Connection panel
// do by hand) and wait for its first index to load, so a later load can't be overwritten.
export async function openLab(page: Page, { anonymous = false } = {}) {
  const conn = { env: 'staging', project: fx.project, ...(anonymous ? {} : { token: synapseToken() }) }
  await page.addInitScript((c) => localStorage.setItem('searchlab.connection', c), JSON.stringify(conn))
  await page.goto('/')
  await expect(page.locator('#envBadge')).toBeVisible()
  await expect(page.locator('#indexStatus .ok')).toBeVisible()
}

// "Other SearchIndex by ID…" → paste the synID → Load. Returns the status line, which
// carries either the index summary or the reason it couldn't load.
export async function loadIndex(page: Page, key: string): Promise<Locator> {
  const status = page.locator('#indexStatus')
  await page.locator('#indexPick').selectOption('custom')
  await page.locator('#customId').fill(fx.indexes[key])
  await page.locator('#loadCustom').click()
  await expect(status).not.toContainText('discovering')
  return status
}

type Levers = Partial<{
  type: string; keywordType: string; field: string; operator: string
  pipelineSource: 'inline' | 'ref' | 'default'; pipelineRef: string; semanticWeight: string
  normalization: string; combination: string
}>
const SELECTS: Record<string, string> = {
  type: '.lv-type', keywordType: '.lv-kwtype', operator: '.lv-operator', pipelineSource: '.lv-pipesrc',
  normalization: '.lv-norm', combination: '.lv-comb',
}
const INPUTS: Record<string, string> = { field: '.lv-field', pipelineRef: '.lv-piperef', semanticWeight: '.lv-semw' }

// One side of the playground's side-by-side comparison.
export class Column {
  readonly el: Locator
  constructor(readonly page: Page, key: 'A' | 'B') {
    this.el = page.locator(`.col[data-col="${key}"]`)
  }

  // Levers are applied in object order — put `type` first, it decides which others show.
  async set(levers: Levers) {
    await this.el.locator('.col-levers').evaluate((d) => { (d as HTMLDetailsElement).open = true })
    for (const [k, v] of Object.entries(levers)) {
      if (SELECTS[k]) await this.el.locator(SELECTS[k]).selectOption(v)
      else await this.el.locator(INPUTS[k]).fill(v)
    }
  }

  async search(q: string) {
    await this.el.locator('.col-q').fill(q)
    await this.el.locator('.go').click()
    await expect(this.el.locator('.results .loading')).toHaveCount(0)
    await expect(this.el.locator('.results > li').first()).toBeVisible()
  }

  async nextPage() {
    const before = await this.el.locator('.hit').count()
    await this.el.locator('.next-page').click()
    // Disabled only while the page is in flight; the re-render replaces or drops it.
    await expect(this.el.locator('.next-page:disabled')).toHaveCount(0)
    return (await this.el.locator('.hit').count()) - before
  }

  error() { return this.el.locator('.errbox') }
  meta() { return this.el.locator('.col-meta') }
  names() { return this.el.locator('.hit .name').allTextContents() }
  scores() { return this.el.locator('.hit .score').allTextContents() }
  async total() { return Number((await this.meta().textContent())!.match(/(\d+) total/)![1]) }
  async dsl() { return JSON.parse((await this.el.locator('.query-json').textContent())!) }
}

// Full-page screenshot attached to the report under `name` — the reviewer's proof per step.
export async function proof(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
}
