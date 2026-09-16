import ui from '@nuxt/ui/vue-plugin'
import type { App } from 'vue'

/**
 * `@nuxt/ui/vue-plugin` is the non-Nuxt entry point the repository itself uses
 * in `playgrounds/vue`, so the examples can be mounted without a Nuxt runtime.
 * It reads from `dist/`, which means the submodule must be installed and built.
 */
export default {
  install(app: App): void {
    app.use(ui)
  },
}
