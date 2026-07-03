import { describe, it, expect } from 'bun:test'
import {
  agentNameSchema,
  modelSchema,
  roleSchema,
  thinkingLevelSchema,
  validateAgentName,
  validateModel,
  validateDescription,
  validateAgentForm,
  validateSkillForm,
  validateAgentDraft,
  validateSkillDraft,
} from '@/components/settings/schema'

// ── thinkingLevelSchema ─────────────────────────────────────────────────────

describe('thinkingLevelSchema', () => {
  it('accepts empty string (unset)', () => {
    expect(thinkingLevelSchema.safeParse('').success).toBe(true)
  })

  it.each(['none', 'low', 'medium', 'high'])('accepts standard level %p', (level) => {
    expect(thinkingLevelSchema.safeParse(level).success).toBe(true)
  })

  it('accepts model-specific levels not in the fallback list (e.g. xhigh, max, minimal)', () => {
    // thinkingLevelSchema is z.string() — the valid set is model-specific and
    // enforced by the UI dropdown, not at save-time schema validation.
    expect(thinkingLevelSchema.safeParse('xhigh').success).toBe(true)
    expect(thinkingLevelSchema.safeParse('max').success).toBe(true)
    expect(thinkingLevelSchema.safeParse('minimal').success).toBe(true)
  })
})

// ── agentNameSchema ─────────────────────────────────────────────────────────

describe('agentNameSchema', () => {
  it.each(['orchestrator', 'member_1', 'a.b-c', 'X123', '9alpha'])(
    'accepts %p',
    (name) => {
      expect(agentNameSchema.safeParse(name).success).toBe(true)
    }
  )

  it.each([
    ['', 'Required'],
    ['.hidden', 'letters, digits'],
    [' spaced', 'letters, digits'],
    ['bad/slash', 'letters, digits'],
    ['a'.repeat(65), 'Max 64'],
  ])('rejects %p with %p message', (name, fragment) => {
    const res = agentNameSchema.safeParse(name)
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues[0]?.message).toContain(fragment)
    }
  })
})

// ── modelSchema ─────────────────────────────────────────────────────────────

describe('modelSchema', () => {
  it.each([
    'openai:gpt-5.4',
    'googlegenai:gemini-3.1-pro-preview',
    'nvidia:stepfun-ai/step-3.5-flash',
    'zai:glm-5-turbo',
  ])('accepts %p', (model) => {
    expect(modelSchema.safeParse(model).success).toBe(true)
  })

  it.each(['', 'nohost', ':missing-provider', 'provider:', 'has spaces:xx'])(
    'rejects %p',
    (model) => {
      expect(modelSchema.safeParse(model).success).toBe(false)
    }
  )
})

// ── roleSchema ──────────────────────────────────────────────────────────────

describe('roleSchema', () => {
  it('accepts lead and member', () => {
    expect(roleSchema.safeParse('lead').success).toBe(true)
    expect(roleSchema.safeParse('member').success).toBe(true)
  })
  it('rejects anything else', () => {
    expect(roleSchema.safeParse('admin').success).toBe(false)
    expect(roleSchema.safeParse('').success).toBe(false)
  })
})

// ── UX helpers ──────────────────────────────────────────────────────────────

describe('validateAgentName', () => {
  it('returns null for valid', () => {
    expect(validateAgentName('alpha')).toBeNull()
  })
  it('returns string message for invalid', () => {
    expect(validateAgentName('.bad')).toBeTruthy()
  })
})

describe('validateModel', () => {
  it('empty + required → Required', () => {
    expect(validateModel('', { required: true })).toBe('Required')
  })
  it('empty + optional → null', () => {
    expect(validateModel('')).toBeNull()
  })
  it('malformed → error string', () => {
    expect(validateModel('foo')).toBeTruthy()
  })
  it('good → null', () => {
    expect(validateModel('openai:gpt-5.4', { required: true })).toBeNull()
  })
})

describe('validateDescription', () => {
  it('empty is fine', () => {
    expect(validateDescription('')).toBeNull()
  })
  it('within 500 chars ok', () => {
    expect(validateDescription('a'.repeat(500))).toBeNull()
  })
  it('over 500 chars → error', () => {
    expect(validateDescription('a'.repeat(501))).toBeTruthy()
  })
})

// ── Full-form validators ────────────────────────────────────────────────────

describe('validateAgentForm', () => {
  it('accepts a minimal valid form', () => {
    const res = validateAgentForm({
      name: 'alpha',
      role: 'lead',
      model: 'openai:gpt-5.4',
    })
    expect(res).toBeNull()
  })

  it('flags missing model', () => {
    const res = validateAgentForm({ name: 'alpha', role: 'lead' })
    expect(res).not.toBeNull()
    expect(res?.model).toBeDefined()
  })

  it('flags bad name', () => {
    const res = validateAgentForm({
      name: '.bad',
      role: 'lead',
      model: 'openai:gpt-5.4',
    })
    expect(res?.name).toBeTruthy()
  })

  it('ignores a legacy temperature field instead of flagging it', () => {
    // temperature was retired as a config field; old drafts that still
    // carry it must not fail to validate.
    const res = validateAgentForm({
      name: 'alpha',
      role: 'lead',
      model: 'openai:gpt-5.4',
      temperature: 99,
    })
    expect(res).toBeNull()
  })
})

describe('validateSkillForm', () => {
  it('accepts a minimal skill', () => {
    const res = validateSkillForm({ name: 'research', description: 'Does research.' })
    expect(res).toBeNull()
  })

  it('rejects empty description', () => {
    const res = validateSkillForm({ name: 'x', description: '' })
    expect(res?.description).toBeTruthy()
  })
})

// ── Draft parsers ───────────────────────────────────────────────────────────

describe('validateAgentDraft', () => {
  it('null on valid draft', () => {
    const raw = `---
name: orchestrator
role: lead
model: openai:gpt-5.4
tools:
  - date
---

You are orchestrator.
`
    expect(validateAgentDraft(raw)).toBeNull()
  })

  it('flags missing frontmatter', () => {
    expect(validateAgentDraft('no frontmatter here')).toHaveProperty('_root')
  })

  it('flags bad model even when rest is valid', () => {
    const raw = `---
name: alpha
role: lead
model: not-a-model
---

body
`
    const res = validateAgentDraft(raw)
    expect(res?.model).toBeTruthy()
  })

  it('ignores a legacy temperature field in an otherwise-valid draft', () => {
    // temperature was retired as a config field; old on-disk agent files
    // that still carry it must still validate cleanly.
    const raw = `---
name: alpha
role: lead
model: openai:gpt-5.4
temperature: 0.2
---

body
`
    expect(validateAgentDraft(raw)).toBeNull()
  })
})

describe('validateSkillDraft', () => {
  it('null on valid', () => {
    const raw = `---
name: research
description: Does web research.
---

Body.
`
    expect(validateSkillDraft(raw)).toBeNull()
  })

  it('flags missing description', () => {
    const raw = `---
name: research
---

Body.
`
    const res = validateSkillDraft(raw)
    expect(res?.description).toBeTruthy()
  })
})
