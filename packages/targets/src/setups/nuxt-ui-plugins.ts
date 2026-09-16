import ui from '@nuxt/ui/vite'
import type { Plugin } from 'vite'

/**
 * Nuxt UI needs its own Vite plugin for icon resolution and Tailwind wiring,
 * even when the components are mounted outside Nuxt.
 */
export default function nuxtUiPlugins(): Plugin[] {
  return [ui({ autoImport: { imports: ['vue'] } }) as unknown as Plugin]
}
