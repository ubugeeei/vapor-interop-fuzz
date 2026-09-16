import 'vuetify/styles'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import type { App } from 'vue'

/**
 * The Vuetify docs examples rely on globally registered `v-*` components, so
 * the harness has to install the plugin before mounting a specimen.
 *
 * Note that the components come from the *published* package here: they are
 * virtual-DOM components, and the specimen wrapped around them is what the
 * fuzzer flips. That is the interop boundary we want for this target.
 */
export default {
  install(app: App): void {
    app.use(
      createVuetify({
        components,
        directives,
        // Pin everything that would otherwise vary between two dev servers.
        theme: { defaultTheme: 'light' },
        ssr: false,
      }),
    )
  },
}
