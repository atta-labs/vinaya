import 'server-only'
import { Parser } from 'htmlparser2'

// A roadmap card's artwork is an SVG an editor uploaded to Sanity, inlined
// into the page's own DOM (an `<img>` is a separate document, so the mark could
// never read `--primary`/`--foreground` or run `marks-motion.css`'s keyframes).
// Inlining CMS markup is an injection surface, so it is sanitized here, on the
// server, before it ever reaches the client component that renders it.
//
// The site layout inlines the CMS logo through this same function, so it runs in
// every page's server render. It parses with htmlparser2 (plain JavaScript, bundled
// with the page) instead of DOMPurify over jsdom: jsdom cannot load in Vercel's
// function runtime (its CommonJS code requires an ES-only module), and a crash
// there stops every background regeneration, so pages never pick up CMS changes.
//
// The element and attribute allowlists are DOMPurify's SVG and SVG-filter
// profiles: they keep `class` (the root's `mm`, which the reduced-motion rule
// targets), `style`, `viewBox`, `pathLength`, `stroke-dasharray` and the
// presentation attributes. Every `on*` handler is dropped (none is allowlisted),
// and `<script>`, `<style>`, `<use>`, `<foreignObject>` and any other element
// outside the list are dropped with everything inside them. Comments, CDATA and
// processing instructions never reach the output. Inside CSS, three things are
// closed here:
//
// - `<style>`: an SVG `<style>` inlined into the page applies to the WHOLE page,
//   not just the mark — forbidden outright.
// - Inline `style`: reduced to an allowlist of the declarations the marks
//   actually use (their motion), with plain values only — no function call, no
//   quote, no backslash escape, no `!important`. That rules out every external
//   load (`url()`, `image-set()`, and escaped spellings of either) and any
//   layout escape (`position:fixed`, `z-index`) that could cover the page.
// - `class`: reduced to the marks' own `mm`/`mm-*` tokens. Any other class would
//   pick up the site's utility CSS — `fixed inset-0 z-50` on the root turns a mark
//   into a page-covering overlay without a single style declaration. `id` is
//   dropped outright: the marks never use one, and a surviving id could collide
//   with, or be targeted by, the page's own.
// - Presentation attributes and `href`/`xlink:href`: may only reference a
//   same-document fragment (`#id`); anything escaped, or naming any other
//   resource, drops the attribute.
// DOMPurify's SVG and SVG-filter element profiles, lower-cased, without `style`.
const SVG_ELEMENTS = new Set([
  'svg',
  'a',
  'altglyph',
  'altglyphdef',
  'altglyphitem',
  'animatecolor',
  'animatemotion',
  'animatetransform',
  'circle',
  'clippath',
  'defs',
  'desc',
  'ellipse',
  'filter',
  'font',
  'g',
  'glyph',
  'glyphref',
  'hkern',
  'image',
  'line',
  'lineargradient',
  'marker',
  'mask',
  'metadata',
  'mpath',
  'path',
  'pattern',
  'polygon',
  'polyline',
  'radialgradient',
  'rect',
  'stop',
  'switch',
  'symbol',
  'text',
  'textpath',
  'title',
  'tref',
  'tspan',
  'view',
  'vkern',
  'feblend',
  'fecolormatrix',
  'fecomponenttransfer',
  'fecomposite',
  'feconvolvematrix',
  'fediffuselighting',
  'fedisplacementmap',
  'fedistantlight',
  'fedropshadow',
  'feflood',
  'fefunca',
  'fefuncb',
  'fefuncg',
  'fefuncr',
  'fegaussianblur',
  'feimage',
  'femerge',
  'femergenode',
  'femorphology',
  'feoffset',
  'fepointlight',
  'fespecularlighting',
  'fespotlight',
  'fetile',
  'feturbulence'
])

// DOMPurify's SVG attribute profile, lower-cased.
const SVG_ATTRIBUTES = new Set([
  'accent-height',
  'accumulate',
  'additive',
  'alignment-baseline',
  'amplitude',
  'ascent',
  'attributename',
  'attributetype',
  'azimuth',
  'basefrequency',
  'baseline-shift',
  'begin',
  'bias',
  'by',
  'class',
  'clip',
  'clippathunits',
  'clip-path',
  'clip-rule',
  'color',
  'color-interpolation',
  'color-interpolation-filters',
  'color-profile',
  'color-rendering',
  'cx',
  'cy',
  'd',
  'dx',
  'dy',
  'diffuseconstant',
  'direction',
  'display',
  'divisor',
  'dominant-baseline',
  'dur',
  'edgemode',
  'elevation',
  'end',
  'exponent',
  'fill',
  'fill-opacity',
  'fill-rule',
  'filter',
  'filterunits',
  'flood-color',
  'flood-opacity',
  'font-family',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-weight',
  'fx',
  'fy',
  'g1',
  'g2',
  'glyph-name',
  'glyphref',
  'gradientunits',
  'gradienttransform',
  'height',
  'href',
  'id',
  'image-rendering',
  'in',
  'in2',
  'intercept',
  'k',
  'k1',
  'k2',
  'k3',
  'k4',
  'kerning',
  'keypoints',
  'keysplines',
  'keytimes',
  'lang',
  'lengthadjust',
  'letter-spacing',
  'kernelmatrix',
  'kernelunitlength',
  'lighting-color',
  'local',
  'marker-end',
  'marker-mid',
  'marker-start',
  'markerheight',
  'markerunits',
  'markerwidth',
  'maskcontentunits',
  'maskunits',
  'max',
  'mask',
  'mask-type',
  'media',
  'method',
  'mode',
  'min',
  'name',
  'numoctaves',
  'offset',
  'operator',
  'opacity',
  'order',
  'orient',
  'orientation',
  'origin',
  'overflow',
  'paint-order',
  'path',
  'pathlength',
  'patterncontentunits',
  'patterntransform',
  'patternunits',
  'pointer-events',
  'points',
  'preservealpha',
  'preserveaspectratio',
  'primitiveunits',
  'r',
  'rx',
  'ry',
  'radius',
  'refx',
  'refy',
  'repeatcount',
  'repeatdur',
  'restart',
  'result',
  'rotate',
  'scale',
  'seed',
  'shape-rendering',
  'slope',
  'specularconstant',
  'specularexponent',
  'spreadmethod',
  'startoffset',
  'stddeviation',
  'stitchtiles',
  'stop-color',
  'stop-opacity',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke',
  'stroke-width',
  'style',
  'surfacescale',
  'systemlanguage',
  'tabindex',
  'tablevalues',
  'targetx',
  'targety',
  'transform',
  'transform-origin',
  'text-anchor',
  'text-decoration',
  'text-orientation',
  'text-rendering',
  'textlength',
  'type',
  'u1',
  'u2',
  'unicode',
  'values',
  'vector-effect',
  'viewbox',
  'visibility',
  'version',
  'vert-adv-y',
  'vert-origin-x',
  'vert-origin-y',
  'width',
  'word-spacing',
  'wrap',
  'writing-mode',
  'xchannelselector',
  'ychannelselector',
  'x',
  'x1',
  'x2',
  'y',
  'y1',
  'y2',
  'z',
  'zoomandpan'
])
const ARIA_ATTRIBUTE = /^aria-[-\w]+$/
// Namespace declarations survive only with their standard value.
const NAMESPACE_DECLARATIONS: Record<string, string> = {
  xmlns: 'http://www.w3.org/2000/svg',
  'xmlns:xlink': 'http://www.w3.org/1999/xlink'
}

const STYLE_PROPERTY = /^(?:animation(?:-[a-z]+)*|transform-box|transform-origin|opacity|--mm-[a-z0-9-]+)$/
const STYLE_VALUE = /^[a-z0-9 .,%-]+$/i
const MARK_CLASS = /^mm(?:-[a-z0-9-]+)?$/
const FRAGMENT_ONLY_ATTRS = new Set(['href', 'xlink:href'])
const URL_OPEN = /url\s*\(\s*['"]?\s*/gi
const FORBIDDEN_IN_ATTR = /\\|image-set|@import|expression\s*\(/i

function sanitizeStyle(style: string): string {
  return style
    .split(';')
    .map((declaration) => {
      const colon = declaration.indexOf(':')
      if (colon === -1) return null
      const property = declaration.slice(0, colon).trim().toLowerCase()
      const value = declaration.slice(colon + 1).trim()
      return STYLE_PROPERTY.test(property) && STYLE_VALUE.test(value) ? `${property}:${value}` : null
    })
    .filter((declaration): declaration is string => declaration !== null)
    .join(';')
}

function referencesOnlyFragments(value: string): boolean {
  if (FORBIDDEN_IN_ATTR.test(value)) return false
  for (const match of value.matchAll(URL_OPEN)) {
    if (value[match.index + match[0].length] !== '#') return false
  }
  return true
}

// The value an allowlisted attribute keeps, or null to drop it.
function sanitizeAttribute(name: string, value: string): string | null {
  if (name === 'id') return null
  if (name === 'class') {
    const tokens = value.split(/\s+/).filter((token) => MARK_CLASS.test(token))
    return tokens.length > 0 ? tokens.join(' ') : null
  }
  if (name === 'style') return sanitizeStyle(value) || null
  if (FRAGMENT_ONLY_ATTRS.has(name) && !value.trim().startsWith('#')) return null
  return referencesOnlyFragments(value) ? value : null
}

function allowedAttribute(name: string, value: string): boolean {
  if (name in NAMESPACE_DECLARATIONS) return NAMESPACE_DECLARATIONS[name] === value
  return SVG_ATTRIBUTES.has(name) || ARIA_ATTRIBUTE.test(name) || name === 'role' || name === 'xlink:href'
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}

export function sanitizeSvg(markup: string): string {
  const out: string[] = []
  // One entry per open element: whether it is written out. A dropped element
  // drops everything inside it, so nothing is written while any entry is false.
  const open: boolean[] = []
  let inCdata = false
  const writing = () => open.every(Boolean)
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const keep = writing() && SVG_ELEMENTS.has(name.toLowerCase())
        open.push(keep)
        if (!keep) return
        let tag = `<${name}`
        for (const [rawName, rawValue] of Object.entries(attributes)) {
          const attrName = rawName.toLowerCase()
          if (!allowedAttribute(attrName, rawValue)) continue
          const value = sanitizeAttribute(attrName, rawValue)
          if (value !== null) tag += ` ${rawName}="${escapeAttribute(value)}"`
        }
        out.push(`${tag}>`)
      },
      ontext(text) {
        if (writing() && !inCdata) out.push(escapeText(text))
      },
      oncdatastart() {
        inCdata = true
      },
      oncdataend() {
        inCdata = false
      },
      onclosetag(name) {
        const kept = writing()
        open.pop()
        if (kept) out.push(`</${name}>`)
      }
    },
    { xmlMode: true, decodeEntities: true, recognizeSelfClosing: true }
  )
  parser.write(markup)
  parser.end()
  return out.join('')
}
