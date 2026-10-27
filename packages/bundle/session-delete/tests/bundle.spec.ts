import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

const root = new URL('../', import.meta.url)

describe('opt-in Session deletion bundle', () => {
  it('installs the Host service and client action without preset-specific tool rows', () => {
    const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8')
    expect(patch).toMatchInlineSnapshot(`
      "- insert:
          - id: optional-session-delete
            name: '@deepseek-ai/dsh-session-delete'
          - id: optional-ui-session-delete
            name: '@deepseek-ai/dsh-client-ui-session-delete'
      "
    `)
    const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
      dsh: { bundle: { patch: string; listedByDefault: boolean } }
      dependencies: Record<string, string>
    }
    expect(manifest.dsh.bundle).toEqual({ patch: './cordis.patch.yml', listedByDefault: false })
    expect(manifest.dependencies).toEqual({
      '@deepseek-ai/dsh-session-delete': 'workspace:*',
      '@deepseek-ai/dsh-client-ui-session-delete': 'workspace:*',
    })
  })

  it('keeps the carrier entry free of runtime behavior', () => {
    expect(() => { apply() }).not.toThrow()
  })
})
