import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')
const core = ['theme-background', 'theme-chrome', 'theme-tools', 'theme-desk', 'paper', 'accent', 'accent-light', 'accent-contrast', 'theme-hover', 'line', 'text', 'muted']

test('component colors use tokens rather than palette-specific literals', () => {
  for (const line of css.split('\n')) {
    if (/#(?:[\da-f]{3,8})\b/i.test(line)) assert.match(line.trim(), /^--[\w-]+:/)
  }
  assert.doesNotMatch(css, /\[data-theme="dark"\]\s+\./)
})

test('every selectable palette has complete light and dark core tokens', () => {
  const appearance = readFileSync(new URL('../src/components/AppearanceDialog.vue', import.meta.url), 'utf8')
  for (const palette of ['ocean', 'plum', 'mono', 'gruvbox']) {
    assert.match(appearance, new RegExp(`${palette}:`))
    for (const selector of [`:root[data-palette="${palette}"]`, `:root[data-theme="dark"][data-palette="${palette}"]`]) {
      const block = css.slice(css.indexOf(selector)).split('}')[0]
      assert.ok(css.includes(selector), selector)
      for (const token of core) assert.ok(block.includes(`--${token}:`), `${selector}: ${token}`)
    }
  }
})

test('Mono literal UI colors are achromatic, excluding semantic status inks', () => {
  for (const match of css.matchAll(/:root(?:\[data-theme="dark"\])?\[data-palette="mono"\]\s*\{([^}]+)\}/g)) {
    for (const [, token, hex] of match[1].matchAll(/--([\w-]+): #([\da-f]+);/g)) {
      if (['danger', 'warning', 'success', 'info'].includes(token)) continue
      assert.equal(hex.slice(0, 2), hex.slice(2, 4), token)
      assert.equal(hex.slice(2, 4), hex.slice(4, 6), token)
    }
  }
})
