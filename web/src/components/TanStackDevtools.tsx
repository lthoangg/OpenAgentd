import { TanStackDevtools as Devtools } from '@tanstack/react-devtools'
import { formDevtoolsPlugin } from '@tanstack/react-form-devtools'
import { hotkeysDevtoolsPlugin } from '@tanstack/react-hotkeys-devtools'
import { pacerDevtoolsPlugin } from '@tanstack/react-pacer-devtools'
import { ReactQueryDevtoolsPanel } from '@tanstack/react-query-devtools'
import { TanStackRouterDevtoolsPanel } from '@tanstack/router-devtools'
import { router } from '@/router'

export function TanStackDevtools() {
  return (
    <Devtools
      plugins={[
        formDevtoolsPlugin(),
        hotkeysDevtoolsPlugin(),
        pacerDevtoolsPlugin(),
        {
          id: 'tanstack-query',
          name: 'TanStack Query',
          render: <ReactQueryDevtoolsPanel />,
        },
        {
          id: 'tanstack-router',
          name: 'TanStack Router',
          render: <TanStackRouterDevtoolsPanel router={router} />,
        },
      ]}
    />
  )
}
