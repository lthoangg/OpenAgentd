// SVG ?react import declarations (mirrors src/vite-env.d.ts for test tsconfig)
declare module '*.svg?react' {
  import type { FC, SVGProps } from 'react'
  const ReactComponent: FC<SVGProps<SVGSVGElement>>
  export default ReactComponent
}

// Type declarations for bun:test module
declare module "bun:test" {
  type AnyFunction = (...args: unknown[]) => unknown

  interface MockInstance<T extends AnyFunction = AnyFunction> {
    mock: { calls: unknown[][] }
    mockClear(): void
    mockReset(): void
    mockRestore(): void
    mockImplementation(fn: T): this
    mockReturnValue(value: ReturnType<T>): this
  }

  interface MockFn<T extends AnyFunction = AnyFunction> extends MockInstance<T> {
    (...args: Parameters<T>): ReturnType<T>
  }

  interface Mock {
    <T extends AnyFunction>(fn?: T): T & MockInstance<T>
    module(path: string, factory: () => unknown): void
  }

  interface Matchers<R> {
    // Bun core matchers
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toStrictEqual(expected: unknown): void
    toBeTruthy(): void
    toBeFalsy(): void
    toBeNull(): void
    toBeUndefined(): void
    toBeDefined(): void
    toBeNaN(): void
    toBeInstanceOf(cls: unknown): void
    toContain(item: unknown): void
    toContainEqual(item: unknown): void
    toHaveLength(length: number): void
    toHaveProperty(keyPath: string | string[], value?: unknown): void
    toMatch(pattern: string | RegExp): void
    toMatchObject(object: Record<string, unknown>): void
    toBeGreaterThan(n: number): void
    toBeGreaterThanOrEqual(n: number): void
    toBeLessThan(n: number): void
    toBeLessThanOrEqual(n: number): void
    toBeCloseTo(n: number, precision?: number): void
    toThrow(error?: unknown): void
    toThrowError(error?: unknown): void
    not: Matchers<R>
    resolves: Matchers<R>
    rejects: Matchers<R>
    // Mock matchers
    toHaveBeenCalled(): void
    toHaveBeenCalledTimes(n: number): void
    toHaveBeenCalledWith(...args: unknown[]): void
    toHaveBeenLastCalledWith(...args: unknown[]): void
    toHaveBeenNthCalledWith(n: number, ...args: unknown[]): void
    toHaveBeenCalledOnce(): void
    toHaveReturnedWith(value: unknown): void
    toHaveLastReturnedWith(value: unknown): void
    // jest-dom matchers (via @testing-library/jest-dom)
    toBeInTheDocument(): void
    toBeVisible(): void
    toBeDisabled(): void
    toBeEnabled(): void
    toBeChecked(): void
    toBeEmptyDOMElement(): void
    toHaveAttribute(attr: string, value?: unknown): void
    toHaveClass(...classes: string[]): void
    toHaveStyle(css: string | Record<string, unknown>): void
    toHaveTextContent(text: string | RegExp): void
    toHaveValue(value: unknown): void
    toHaveFocus(): void
    toHaveDisplayValue(value: string | RegExp | Array<string | RegExp>): void
    toBeRequired(): void
    toBeInvalid(): void
    toBeValid(): void
    toBePartiallyChecked(): void
  }

  interface Expect {
    (value: unknown): Matchers<unknown>
    unreachable(message?: string): never
    assertions(count: number): void
    hasAssertions(): void
    any(constructor: unknown): unknown
    anything(): unknown
    arrayContaining(arr: unknown[]): unknown
    objectContaining(obj: Record<string, unknown>): unknown
    stringContaining(str: string): unknown
    stringMatching(pattern: string | RegExp): unknown
  }

  interface ItFunction {
    /** ``timeout`` (ms) replaces Bun's 5 s default for one slow test. */
    (label: string, fn: () => void | Promise<void>, timeout?: number): void
    // Tuple spread overload: each([[a, b], [c, d]]) → fn(a, b)
    each<T extends unknown[]>(cases: T[]): (label: string, fn: (...args: T) => void | Promise<void>) => void
    // Single-value overload: each([a, b, c]) → fn(a)
    each<T>(cases: T[]): (label: string, fn: (item: T) => void | Promise<void>) => void
  }

  interface DescribeFunction {
    (label: string, fn: () => void): void
    each<T extends unknown[]>(cases: T[]): (label: string, fn: (...args: T) => void) => void
    each<T>(cases: T[]): (label: string, fn: (item: T) => void) => void
  }

  export const describe: DescribeFunction
  export const it: ItFunction
  export const test: ItFunction
  export function beforeEach(fn: () => void | Promise<void>): void
  export function afterEach(fn: () => void | Promise<void>): void
  export function beforeAll(fn: () => void | Promise<void>): void
  export function afterAll(fn: () => void | Promise<void>): void
  export const mock: Mock
  export const spyOn: <T extends object, K extends keyof T>(obj: T, method: K) => MockInstance
  export const expect: Expect
}
