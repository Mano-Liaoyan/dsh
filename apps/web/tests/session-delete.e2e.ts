/** Optional Session deletion through the profile Loader, generated RPC, and authoritative catalog updates. */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import type {} from '@deepseek-ai/dsh-session-delete'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const BUNDLE_PATCH = fileURLToPath(new URL('../../../packages/bundle/session-delete/cordis.patch.yml', import.meta.url))
const BUNDLE_MANIFEST = fileURLToPath(new URL('../../../packages/bundle/session-delete/package.json', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))

it('cancels without deletion and deletes both cold and displayed Sessions through authoritative updates', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: BUNDLE_PATCH,
    extraInstallAnchors: [BUNDLE_MANIFEST],
  })
  onTestFinished(() => scaffold.close())
  const fixture = await readFile(SEED, 'utf8')
  const cold = await seedSession(scaffold, fixture, 'session-delete-cold')
  const loaded = await seedSession(scaffold, fixture, 'session-delete-loaded')
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  await workspace.attachSession(cold)
  await workspace.attachSession(loaded)
  const deletions: string[] = []
  scaffold.ctx.on('session-persistence/deleted', (id) => { deletions.push(id) })
  expect(scaffold.ctx.sessions.get(cold)).toBeUndefined()
  expect(scaffold.ctx.get('sessionDelete')).toBeDefined()

  const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const tripwire = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-session-delete'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  const group = page.locator('[role="treeitem"][aria-expanded]').filter({
    has: page.getByText(basename(scaffold.workspaceCwd), { exact: true }),
  })
  await group.waitFor()
  const coldRow = page.locator(`[role="treeitem"][data-row-key="session:${cold}"]`)
  const loadedRow = page.locator(`[role="treeitem"][data-row-key="session:${loaded}"]`)
  await expect.poll(async () => {
    if (await group.getAttribute('aria-expanded') === 'false') await group.click()
    return coldRow.isVisible()
  }, { timeout: 15_000 }).toBe(true)
  await loadedRow.waitFor()
  expect(scaffold.ctx.sessions.get(cold)).toBeUndefined()

  const openColdConfirmation = async () => {
    await coldRow.hover()
    await coldRow.getByRole('button', { name: /^Session actions for / }).click()
    await page.getByRole('menuitem', { name: 'Delete session', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete this session?', exact: true })
    await dialog.waitFor()
    expect(await page.getByRole('menu').count()).toBe(0)
    return dialog
  }

  let dialog = await openColdConfirmation()
  expect(await dialog.textContent()).toContain('Files in your workspace are not deleted.')
  expect(await dialog.textContent()).toContain('Stop any running work')
  expect(await dialog.textContent()).toContain('You can also delete the session currently on screen.')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  expect(await coldRow.count()).toBe(1)
  expect(await scaffold.ctx.sessionPersistence.stat(cold)).toBeDefined()
  expect(deletions).toEqual([])

  dialog = await openColdConfirmation()
  await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Session deleted.' }).waitFor()
  await coldRow.waitFor({ state: 'detached' })
  expect(await scaffold.ctx.sessionPersistence.stat(cold)).toBeUndefined()
  expect((await scaffold.ctx.sessionPersistence.list()).map(row => row.header.id)).not.toContain(cold)
  expect(deletions).toEqual([cold])
  expect(scaffold.ctx.sessions.get(cold)).toBeUndefined()

  await loadedRow.click()
  await page.locator('[data-composer-input][contenteditable="true"]').waitFor()
  await expect.poll(() => scaffold.ctx.sessions.get(loaded), { timeout: 15_000 }).toBeDefined()
  await loadedRow.hover()
  await loadedRow.getByRole('button', { name: /^Session actions for / }).click()
  await page.getByRole('menuitem', { name: 'Delete session', exact: true }).click()
  await page.getByRole('dialog', { name: 'Delete this session?', exact: true })
    .getByRole('button', { name: 'Delete permanently', exact: true }).click()
  await loadedRow.waitFor({ state: 'detached' })
  await page.getByRole('alert').filter({ hasText: 'Session deleted.' }).waitFor()
  expect(await scaffold.ctx.sessionPersistence.stat(loaded)).toBeUndefined()
  expect(scaffold.ctx.sessions.get(loaded)).toBeUndefined()
  expect((await scaffold.ctx.sessionPersistence.list()).map(row => row.header.id)).not.toContain(loaded)
  expect(deletions).toEqual([cold, loaded])
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dsh.sessions.current'))).toBe('{}')
  await expect.poll(() => page.locator('[data-composer-input][contenteditable="true"]').count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
})
