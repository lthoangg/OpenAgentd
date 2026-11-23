import { describe, expect, it } from 'bun:test'

import { deviceLabel, devicePreset, fitScale, frameSize } from '@/components/Preview/devices'
import {
  buildDesignFeedback,
  commentsFromFeedback,
  compactStyles,
  elementLabel,
  feedbackMatchesTarget,
  previewTargetForFeedback,
  resolveSourceFile,
  sourceReference,
  workspaceRelative,
  type PreviewComment,
} from '@/components/Preview/preview-comments'
import { designFeedbackMentions } from '@/lib/design-feedback'
import type { ElementDescriptor } from '@/components/Preview/preview-protocol'

const WS = '/Users/me/project'

function element(overrides: Partial<ElementDescriptor> = {}): ElementDescriptor {
  return {
    selector: 'main > section.pricing > button.cta',
    tag: 'button',
    id: null,
    classes: ['cta', 'primary', 'big'],
    role: null,
    ariaLabel: null,
    text: 'Start free',
    html: '<button class="cta">',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    styles: {},
    source: { file: `${WS}/src/Pricing.tsx`, line: 42, component: 'Pricing' },
    path: '/pricing',
    ...overrides,
  }
}

const comment = (n: number, text: string, el = element()): PreviewComment => ({ id: `c${n}`, n, element: el, text })

describe('preview comments', () => {
  it('labels elements like a selector', () => {
    expect(elementLabel(element())).toBe('<button.cta.primary>')
    expect(elementLabel(element({ id: 'root' }))).toBe('<button#root>')
    expect(elementLabel(element({ classes: [] }))).toBe('<button>')
  })

  it('turns workspace sources into @ references', () => {
    expect(workspaceRelative(`${WS}/src/App.tsx`, WS)).toBe('src/App.tsx')
    expect(workspaceRelative(`/@fs${WS}/src/App.vue?vue&type=script`, WS)).toBe('src/App.vue')
    expect(workspaceRelative('src/Card.svelte', WS)).toBe('src/Card.svelte')
    expect(workspaceRelative('/elsewhere/x.tsx', WS)).toBeNull()
    expect(workspaceRelative('../x.tsx', WS)).toBeNull()
    // The element's line plus the next 29, so its markup and children come along.
    expect(sourceReference({ file: `${WS}/src/App.tsx`, line: 7, component: null }, WS)).toBe('@src/App.tsx#L7-L36')
    expect(sourceReference({ file: 'src/App.vue', line: null, component: null }, WS)).toBe('@src/App.vue')
    expect(sourceReference({ file: '/lib/x.js', line: 3, component: null }, WS)).toBe('/lib/x.js:3')
    expect(sourceReference(null, WS)).toBeNull()
  })

  it('builds design feedback for the agent', () => {
    const feedback = buildDesignFeedback({
      comments: [
        comment(1, ' Make this larger\nand use the accent color. ', element({ styles: { display: 'inline-block', 'font-size': '14px', margin: '0px', 'background-color': 'rgba(0, 0, 0, 0)' } })),
        comment(5, 'Tighter gap', element({ source: { file: null, line: null, component: 'Hero' }, text: '', selector: '#hero' })),
      ],
      workspace: WS,
      origin: 'http://localhost:5173',
      device: 'Mobile 390×844',
    })
    expect(feedback).toEqual({
      where: 'http://localhost:5173/pricing',
      device: 'Mobile 390×844',
      items: [
        { n: 1, element: '<button.cta.primary>', text: 'Start free', selector: 'main > section.pricing > button.cta', source: '@src/Pricing.tsx#L42-L71', html: '<button class="cta">', styles: 'display: inline-block; font-size: 14px', page: null, comment: 'Make this larger\nand use the accent color.' },
        { n: 2, element: '<button.cta.primary>', text: '', selector: '#hero', source: 'component Hero', html: '<button class="cta">', styles: '', page: null, comment: 'Tighter gap' },
      ],
    })
    // Workspace sources become composer mentions, so the backend attaches their lines.
    expect(designFeedbackMentions(feedback)).toEqual(['src/Pricing.tsx#L42-L71'])
    expect(compactStyles({ color: 'red', padding: '0px' })).toBe('color: red')
  })

  it('names the page per comment when they span pages, and the file for file previews', () => {
    const feedback = buildDesignFeedback({
      comments: [comment(1, 'a'), comment(2, 'b', element({ path: '/about' })), comment(3, 'c', element({ source: { file: '/lib/x.js', line: 3, component: null } }))],
      workspace: WS,
      origin: null,
      filePath: 'designs/landing.html',
      device: 'Desktop 1440×900',
    })
    expect(feedback.where).toBe('@designs/landing.html')
    expect(feedback.items.map((i) => i.page)).toEqual(['/pricing', '/about', '/pricing'])
    expect(feedback.items[2].source).toBe('/lib/x.js:3')
    // Deduplicated; sources outside the workspace are not mentions.
    expect(designFeedbackMentions(feedback)).toEqual(['designs/landing.html', 'src/Pricing.tsx#L42-L71'])
  })

  it('turns sent feedback back into comments that rebuild the same feedback', () => {
    const original = buildDesignFeedback({
      comments: [
        comment(1, 'Make this larger', element({ styles: { 'font-size': '14px', color: 'rgb(1, 2, 3)' } })),
        comment(2, 'Tighter', element({ id: 'hero', classes: [], source: { file: null, line: null, component: 'Hero' }, path: '/about' })),
        comment(3, 'Outside', element({ source: { file: '/lib/x.js', line: 3, component: null } })),
      ],
      workspace: WS,
      origin: 'http://localhost:5173',
      device: 'Desktop 1440×900',
    })
    const back = commentsFromFeedback(original)
    expect(back.map((c) => c.text)).toEqual(['Make this larger', 'Tighter', 'Outside'])
    expect(back[1].element.path).toBe('/about')
    const rebuilt = buildDesignFeedback({
      comments: back.map((c, i) => ({ ...c, id: `r${i}`, n: i + 1 })),
      workspace: WS,
      origin: 'http://localhost:5173',
      device: 'Desktop 1440×900',
    })
    expect(rebuilt).toEqual(original)
  })

  it('maps dev server paths to workspace files', () => {
    const files = ['web/src/Pricing.tsx', 'web/src/components/Card.tsx', 'docs/src/Card.tsx', 'src/App.tsx']
    // The dev server's root is a subfolder: match by suffix.
    expect(resolveSourceFile('/src/Pricing.tsx', WS, files)).toBe(`${WS}/web/src/Pricing.tsx`)
    // Several matches: the shortest path wins.
    expect(resolveSourceFile('/src/components/Card.tsx', WS, [...files, 'x/web/src/components/Card.tsx'])).toBe(`${WS}/web/src/components/Card.tsx`)
    // Already a workspace file: unchanged.
    expect(resolveSourceFile(`${WS}/src/App.tsx`, WS, files)).toBeNull()
    expect(resolveSourceFile('/src/App.tsx', WS, files)).toBe(`${WS}/src/App.tsx`)
    // Relative (Svelte) and /@fs paths.
    expect(resolveSourceFile('src/Pricing.tsx', WS, files)).toBe(`${WS}/web/src/Pricing.tsx`)
    expect(resolveSourceFile('/nowhere/X.tsx', WS, files)).toBeNull()
    expect(resolveSourceFile('/src/Pricing.tsx', WS, [])).toBeNull()
  })

  it('finds the preview tab sent feedback came from', () => {
    const url = { where: 'http://localhost:5173/pricing', device: '', items: [] }
    const file = { where: '@designs/landing.html', device: '', items: [] }
    expect(previewTargetForFeedback(url)).toEqual({ kind: 'url', url: 'http://localhost:5173/pricing' })
    expect(previewTargetForFeedback(file)).toEqual({ kind: 'file', path: 'designs/landing.html' })
    expect(previewTargetForFeedback({ ...url, where: 'the page' })).toBeNull()
    expect(feedbackMatchesTarget(url, { kind: 'url', url: 'http://localhost:5173' })).toBe(true)
    expect(feedbackMatchesTarget(url, { kind: 'url', url: 'http://localhost:3000' })).toBe(false)
    expect(feedbackMatchesTarget(file, { kind: 'file', path: 'designs/landing.html' })).toBe(true)
    expect(feedbackMatchesTarget(file, { kind: 'url', url: 'http://localhost:5173' })).toBe(false)
  })
})

describe('device presets', () => {
  it('sizes, rotates, and fits frames', () => {
    const mobile = devicePreset('mobile')
    expect(frameSize(mobile, false)).toEqual({ width: 390, height: 844 })
    expect(frameSize(mobile, true)).toEqual({ width: 844, height: 390 })
    expect(frameSize(devicePreset('responsive'), false)).toBeNull()
    expect(devicePreset('nope').id).toBe('responsive')
    expect(fitScale({ width: 1440, height: 900 }, { width: 720, height: 900 })).toBe(0.5)
    expect(fitScale({ width: 390, height: 844 }, { width: 2000, height: 2000 })).toBe(1)
    expect(deviceLabel(devicePreset('responsive'), null, { width: 812.4, height: 640 })).toBe('Responsive 812×640')
  })
})
