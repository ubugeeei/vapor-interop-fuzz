import vueJsx from '@vitejs/plugin-vue-jsx'
import jsxVapor from 'vue-jsx-vapor/vite'
import type { Plugin } from 'vite'

/**
 * Component-level switching for a JSX codebase.
 *
 * Vuetify writes its components as TSX, so there is no `vapor` block attribute
 * to toggle. The equivalent knob is *which compiler sees the file*:
 * `vue-jsx-vapor` emits Vapor code, `@vitejs/plugin-vue-jsx` emits vnodes. Both
 * are unplugin/Vite plugins with include/exclude filters, so the plan can route
 * each file to exactly one of them.
 *
 * `isVapor` is evaluated per transform rather than captured, so the routing
 * follows the current case without restarting the dev server.
 */
export default function vuetifyJsxPlugins(isVapor: (absoluteId: string) => boolean): Plugin[] {
  return [
    jsxVapor({
      include: [/\.[jt]sx$/],
      exclude: [(id: string) => !isVapor(id)],
    }) as Plugin,
    vueJsx({
      include: /\.[jt]sx$/,
      exclude: [(id: string) => isVapor(id)],
    }) as Plugin,
  ]
}
