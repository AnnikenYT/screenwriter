// Human editor presence colors are separate from screenplay character colors.
// Character colors live in document meta under sheet:characters:<id>:color.
export const EDITOR_COLOR_PRESETS = [
  '#1d4ed8', '#0f766e', '#6d28d9', '#b91c1c', '#a16207', '#15803d',
  '#0e7490', '#c2410c', '#be185d', '#4338ca', '#047857', '#7e22ce',
]

export function isEditorColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
}

export function normalizeEditorColor(value) {
  return isEditorColor(value) ? value.toLowerCase() : null
}

function hash(value) {
  let result = 2166136261
  for (const letter of value) result = Math.imul(result ^ letter.codePointAt(0), 16777619)
  return result >>> 0
}

function hslToHex(hue, saturation, lightness) {
  saturation /= 100
  lightness /= 100
  const channel = offset => {
    const k = (offset + hue / 30) % 12
    const a = saturation * Math.min(lightness, 1 - lightness)
    return lightness - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))
  }
  return `#${[0, 8, 4].map(offset => Math.round(channel(offset) * 255).toString(16).padStart(2, '0')).join('')}`
}

// A stable default per editor id keeps two people visually apart even before
// either person picks a color. The hue range is deliberately broad so replacing
// the old fixed blue/purple defaults does not make every collaborator look alike.
export function defaultEditorColor(seed = '') {
  const value = hash(String(seed))
  return hslToHex(value % 360, 58 + (value >>> 9) % 11, 32 + (value >>> 17) % 9)
}

export function editorColorInk(color) {
  if (!isEditorColor(color)) return '#ffffff'
  const [red, green, blue] = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16))
  const linear = value => {
    value /= 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
  const blackContrast = (luminance + 0.05) / 0.05
  const whiteContrast = 1.05 / (luminance + 0.05)
  return blackContrast >= whiteContrast ? '#000000' : '#ffffff'
}
