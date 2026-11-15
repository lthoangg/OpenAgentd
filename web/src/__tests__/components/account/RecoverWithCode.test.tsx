/**
 * The recovery-code form: only a code of the right shape goes on, and
 * nothing keeps the code once it has.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { looksLikeRecoveryCode, RecoveredNote, RecoverWithCode } from '@/components/account/RecoverWithCode'

const CODE = Array.from({ length: 13 }, () => 'AB27').join('-')

afterEach(cleanup)

describe('looksLikeRecoveryCode', () => {
  it('takes 52 base32 characters, with or without dashes, spaces and case', () => {
    expect(looksLikeRecoveryCode(CODE)).toBe(true)
    expect(looksLikeRecoveryCode(CODE.toLowerCase().replaceAll('-', ' '))).toBe(true)
  })

  it('refuses a short code and characters base32 has not', () => {
    expect(looksLikeRecoveryCode(CODE.slice(0, -1))).toBe(false)
    expect(looksLikeRecoveryCode(CODE.replace('2', '1'))).toBe(false)
  })
})

describe('RecoverWithCode', () => {
  it('says what a code looks like and keeps Continue off until it has that shape', () => {
    const sent: string[] = []
    render(<RecoverWithCode device="computer" busy={false} onRecover={(code) => sent.push(code)} />)

    fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: 'ABCD-EFGH' } })
    expect(screen.getByRole('alert').textContent).toContain('13 groups of 4')
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
    expect(sent).toEqual([])
  })

  it('sends the code and clears the field', () => {
    const sent: string[] = []
    render(<RecoverWithCode device="computer" busy={false} onRecover={(code) => sent.push(code)} />)

    const field = screen.getByLabelText('Recovery code') as HTMLInputElement
    expect(field.type).toBe('password')
    fireEvent.change(field, { target: { value: `  ${CODE} ` } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(sent).toEqual([CODE])
    expect(field.value).toBe('')
  })
})

describe('RecoveredNote', () => {
  it('says plainly that the recovery code stays the same', () => {
    let done = 0
    render(<RecoveredNote device="phone" busy={false} onDone={() => { done += 1 }} />)

    expect(screen.getByText(/This phone can now add devices/)).toBeTruthy()
    expect(screen.getByText('Your recovery code stays the same. Keep it somewhere safe.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(done).toBe(1)
  })
})
