import { getPlatform } from '@/hooks/use-platform'

export interface NativePickerOption {
  id: string
  label: string
}

/**
 * Let the user choose one value in the phone's own control: an action sheet
 * on iOS, a single-choice dialog on Android. Use it for a short list of
 * simple values (a theme, a sort order); anything searchable or rich stays an
 * in-app control.
 *
 * Resolves with:
 *   - the chosen option's ``id``;
 *   - ``null`` when the user dismissed it (Cancel, Back, tap outside);
 *   - ``undefined`` when there is no native picker to show — outside the
 *     mobile shell, no options, or the command failed — and the caller
 *     should show its own control. A failure is deliberately *not* a
 *     dismissal: the user asked to choose and nothing appeared.
 *
 * ``selected`` is the current ``id``; the platform marks it.
 */
export async function pickNative(
  title: string,
  options: readonly NativePickerOption[],
  selected?: string,
): Promise<string | null | undefined> {
  const { isTauri, os } = getPlatform()
  if (!isTauri || (os !== 'ios' && os !== 'android') || options.length === 0) return undefined
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const picked = await invoke<string | null>('pick_one', {
      title,
      // Only what the shell reads: the options may carry UI-only fields.
      options: options.map(({ id, label }) => ({ id, label })),
      ...(selected === undefined ? {} : { selected }),
    })
    return picked ?? null
  } catch {
    return undefined
  }
}
