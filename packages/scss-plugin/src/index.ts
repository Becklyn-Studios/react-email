import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { generate, parse, walk } from 'css-tree';
import type { Plugin } from 'esbuild';
import * as sass from 'sass';

export interface ScssPluginOptions {
  /**
   * Which files are treated as SCSS modules, i.e. get their class names scoped and
   * exported. Files outside it are compiled but keep their class names as written.
   */
  filter?: RegExp;
  /** Project root that scope hashes are derived from, so they survive a move of the repo. */
  root?: string;
}

/**
 * Compiles `*.module.scss` imports into a module exporting the compiled CSS and a map
 * of local class names to scoped ones:
 *
 *     import styles, { css } from './welcome.module.scss';
 *     <Scss sheets={[css]}><Heading className={styles.heading} /></Scss>
 *
 * Compilation happens while the template is bundled, in this process, so `sass` is
 * never bundled into the template — its compiled-to-JS output does not survive that.
 */
export const scssModules = (options: ScssPluginOptions = {}): Plugin => {
  const filter = options.filter ?? /\.module\.scss$/;
  const root = options.root ?? process.cwd();

  return {
    name: 'scss-modules',
    setup(build) {
      build.onLoad({ filter }, (args) => {
        const { css, loadedUrls } = sass.compile(args.path);
        const ast = parse(css, { context: 'stylesheet' });
        const classes = scopeClassNames(ast, scopeFor(relative(root, args.path)));

        return {
          loader: 'js',
          contents: [
            `export const css = ${JSON.stringify(generate(ast))};`,
            `export default ${JSON.stringify(classes)};`,
          ].join('\n'),
          // Re-bundle when a partial the stylesheet pulls in changes, not just the entry.
          watchFiles: loadedUrls
            .filter((url) => url.protocol === 'file:')
            .map((url) => url.pathname),
        };
      });
    },
  };
};

/** Scope suffix derived from the file's path, so two modules may share a class name. */
const scopeFor = (relativePath: string) =>
  createHash('sha256').update(relativePath).digest('hex').slice(0, 8);

/** Rewrites every class selector in place, returning the local -> scoped mapping. */
function scopeClassNames(ast: ReturnType<typeof parse>, scope: string) {
  const classes: Record<string, string> = {};
  walk(ast, (node) => {
    if (node.type !== 'ClassSelector') return;
    classes[node.name] ??= `${node.name}_${scope}`;
    node.name = classes[node.name]!;
  });
  return classes;
}
