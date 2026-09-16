# setups

Glue modules for individual targets. They are excluded from `tsconfig.json`
on purpose: each one imports code that only exists once the corresponding
submodule has been installed (and in some cases built), so type-checking the
repository must not depend on having every target set up.
