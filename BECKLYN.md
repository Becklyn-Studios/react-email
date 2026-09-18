# Becklyn fork of React Email

Adds SCSS support on top of upstream React Email:

- **`react-email.config.*`** — loaded through jiti, merging `esbuild.plugins` and
  `esbuild.external` into both places templates get bundled: the `export` command and the
  preview server.
- **`<Scss>`** — exported from `react-email`, beside `<Tailwind>`. Inlines a stylesheet's
  rules into `style` attributes, because email clients strip stylesheets. Rules that cannot
  be inlined (`@media`, pseudo-selectors, descendant selectors) go into a `<style>` in
  `<Head>`, forced to `!important` so they are not beaten by those inline attributes.
- **`@react-email/scss-plugin`** — compiles `*.module.scss` while templates are bundled,
  into a module exporting the compiled CSS and a scoped class map. sass runs in the bundler
  process; it does not survive being bundled into a template.

## Branches

One branch per upstream version, `becklyn/<react-email version>`, cut from that version's
upstream tag and carrying our patches. Branches are never force-pushed, and consumers pin a
commit, so nothing moves underneath them.

`git log react-email@<version>..becklyn/<version>` shows exactly our patch set.

## Using it from another repository

Add this repo as a submodule, check out the branch matching the react-email version you
want, then run the init script from your repository's root:

```bash
git submodule add git@github.com:Becklyn-Studios/react-email.git tools/react-email
cd tools/react-email && git checkout becklyn/6.9.5 && cd ../..

node tools/react-email/scripts/init.mjs
```

It asks where your templates live, links `react-email`, `@react-email/ui` and
`@react-email/scss-plugin` into that package, writes `react-email.config.ts` and the
`*.module.scss` type declaration, and offers to add `email:dev` / `email:build` to your root
`package.json`. It is safe to re-run: existing files are left alone.

Every answer can be passed up front, which also makes it work without a terminal:

```bash
node tools/react-email/scripts/init.mjs --templates=shared/emails --source=src --scripts
```

Then:

```bash
pnpm install
pnpm email:build     # first run compiles the fork; later runs are cached by turbo
pnpm email:dev       # preview on :3000
```

`@react-email/ui` has to be linked as well as `react-email`: the CLI resolves it from your
project and refuses to start unless its version matches `react-email`'s exactly.

### Overriding the export directory

The init script bakes `--outDir` into the `export` script, and a later `--outDir` wins, so
it can still be changed per call — but pass it **without** a `--` separator:

```bash
pnpm --filter <templates package> export --outDir dist    # works
pnpm --filter <templates package> export -- --outDir dist # fails
```

pnpm forwards the separator verbatim, and the CLI then rejects it with
`too many arguments for 'export'`. Note this is the opposite of `email:dev`, which goes
through turbo and *does* need the separator: `pnpm email:dev -- --port=3010`.

## Writing templates

The stylesheet sits next to the template and is imported directly:

```tsx
import { Scss } from "react-email";
import styles, { css } from "./welcome.module.scss";

<Scss sheets={[css]}>
  <Html>
    <Head />
    <Heading className={styles.heading}>Hello</Heading>
  </Html>
</Scss>
```

Only a rule selected by a single bare class is inlined. Nesting that produces a descendant
selector, a pseudo-selector or an at-rule ends up in the `<style>` block instead, which many
clients strip — treat those as progressive enhancement.

## Working on the fork

```bash
corepack pnpm install
corepack pnpm exec turbo run build --filter=react-email --filter=@react-email/ui --filter=@react-email/scss-plugin
```

This repo pins pnpm 11 via `packageManager`; invoke pnpm through corepack so it picks the
right version rather than inheriting the consuming repository's.
