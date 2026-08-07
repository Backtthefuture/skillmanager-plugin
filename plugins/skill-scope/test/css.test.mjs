// Regression: CSS display rules must never override the HTML `hidden` attribute.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('dashboard.css contains a global [hidden] override', async () => {
  const css = await fs.readFile(path.join(root, 'web', 'dashboard.css'), 'utf8')
  assert.match(css, /^\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/m,
    '[hidden] { display: none !important; } must exist in dashboard.css')
})

test('every element toggled with .hidden in dashboard.js exists in index.html', async () => {
  const js = await fs.readFile(path.join(root, 'web', 'dashboard.js'), 'utf8')
  const html = await fs.readFile(path.join(root, 'web', 'index.html'), 'utf8')
  const toggledIds = [...js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)\.hidden\s*=/g)].map((match) => match[1])
  assert.ok(toggledIds.length >= 8, `expected several hidden-toggled ids, got ${toggledIds.length}`)
  for (const id of new Set(toggledIds)) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `index.html must contain #${id}`)
  }
})

test('display classes that used to hide elements are covered by the [hidden] rule', async () => {
  const css = await fs.readFile(path.join(root, 'web', 'dashboard.css'), 'utf8')
  for (const selector of ['.modal', '.toast', '.field', '.view', '.context-warning', '.error-banner']) {
    const rule = css.match(new RegExp(`${selector.replace('.', '\\.')}\\s*\\{[^}]*\\}`, 'm'))?.[0] || ''
    if (rule.includes('display:')) {
      assert.ok(css.includes('[hidden] { display: none !important; }'),
        `${selector} sets display but the global [hidden] override must exist`)
    }
  }
})
