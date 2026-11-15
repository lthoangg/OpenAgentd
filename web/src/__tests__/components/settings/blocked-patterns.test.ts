import { describe, expect, it } from 'bun:test'
import { describePattern, folderPattern } from '@/components/settings/blocked-patterns'

describe('describePattern', () => {
  it('reads a file name at any depth', () => {
    expect(describePattern('**/.env')).toBe('Any file named .env')
    expect(describePattern('**/id_rsa')).toBe('Any file named id_rsa')
  })

  it('reads a name prefix', () => {
    expect(describePattern('**/.env.*')).toBe('Any file whose name starts with .env.')
    expect(describePattern('**/id_rsa*')).toBe('Any file whose name starts with id_rsa')
  })

  it('reads a file extension', () => {
    expect(describePattern('**/*.pem')).toBe('Any .pem file')
  })

  it('reads a folder name at any depth', () => {
    expect(describePattern('**/secrets/**')).toBe('Everything in any folder named secrets')
  })

  it('reads one folder by its last name', () => {
    expect(describePattern('/Users/me/Documents/taxes/**')).toBe('Everything in taxes')
    expect(describePattern('C:/Users/me/taxes/**')).toBe('Everything in taxes')
  })

  it('calls anything else a pattern of your own, and an empty row a new one', () => {
    expect(describePattern('**/a*/b?/**')).toBe('Your own pattern')
    expect(describePattern('secrets/**')).toBe('Your own pattern')
    expect(describePattern('   ')).toBe('New pattern')
  })
})

describe('folderPattern', () => {
  it('blocks everything in the folder', () => {
    expect(folderPattern('/Users/me/Documents/taxes')).toBe('/Users/me/Documents/taxes/**')
    expect(folderPattern('/Users/me/Documents/taxes/')).toBe('/Users/me/Documents/taxes/**')
  })

  it('writes a Windows path with forward slashes', () => {
    expect(folderPattern('C:\\Users\\me\\taxes')).toBe('C:/Users/me/taxes/**')
  })

  it('keeps pattern characters in a folder name literal', () => {
    expect(folderPattern('/data/notes [old]/a*b?')).toBe('/data/notes [[]old]/a[*]b[?]/**')
  })

  it('still reads as one folder after that', () => {
    expect(describePattern(folderPattern('/data/taxes 2024'))).toBe('Everything in taxes 2024')
  })
})
