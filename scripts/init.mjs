#!/usr/bin/env node
/**
 * Wires this fork into the repository that includes it as a git submodule, scaffolding a
 * templates package if there is not one yet.
 *
 * Run it from the consuming repository's root, after adding the submodule:
 *
 *     node tools/react-email/scripts/init.mjs
 *
 * Every answer can be given up front, which also makes it usable without a terminal:
 *
 *     node tools/react-email/scripts/init.mjs --templates=shared/emails --source=src \
 *       --output=html --scripts
 *
 * Nothing is overwritten: files that already exist are left alone, so it is safe to re-run
 * after moving the submodule or adding it to another package. Plain Node with no
 * dependencies, so it works before anything is installed.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const CONSUMER_ROOT = process.cwd();
const SUBMODULE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SUBMODULE_REL = path.relative(CONSUMER_ROOT, SUBMODULE_ROOT);

const LINKED_PACKAGES = {
  'react-email': 'packages/react-email',
  '@react-email/ui': 'packages/ui',
  '@react-email/scss-plugin': 'packages/scss-plugin',
};

// react-email peers ^18 || ^19; this keeps a fresh scaffold on the current major.
const REACT_VERSION = '^19.0.0';

// An empty relative path means the cwd is the submodule itself; '..' means it is outside.
if (SUBMODULE_REL === '' || SUBMODULE_REL.startsWith('..')) {
  console.error(
    'Run this from the root of the repository that includes this submodule, not from inside it:\n' +
      '  cd /path/to/your-repo && node <submodule path>/scripts/init.mjs',
  );
  process.exit(1);
}

const flags = new Map(
  process.argv.slice(2).map((argument) => {
    const [name, value] = argument.replace(/^--/, '').split('=');
    return [name, value ?? 'true'];
  }),
);

// Without a terminal there is nobody to answer, so fall back to the flags and defaults
// rather than hanging or crashing half way through.
const interactive = process.stdin.isTTY === true;
const rl = interactive
  ? createInterface({ input: process.stdin, output: process.stdout })
  : undefined;

const ask = async (question, fallback, flag) => {
  if (flags.has(flag)) return flags.get(flag);
  if (!rl) {
    console.log(`${question} ${fallback}`);
    return fallback;
  }
  const answer = (await rl.question(`${question} [${fallback}] `)).trim();
  return answer || fallback;
};

const confirm = async (question, fallback, flag) => {
  if (flags.has(flag)) return flags.get(flag) !== 'false';
  if (flags.has(`no-${flag}`)) return false;
  if (!rl) {
    console.log(`${question} ${fallback ? 'yes' : 'no'}`);
    return fallback;
  }
  const answer = (await rl.question(`${question} [${fallback ? 'Y/n' : 'y/N'}] `))
    .trim()
    .toLowerCase();
  if (!answer) return fallback;
  return answer.startsWith('y');
};

const indents = new Map();
const rememberIndent = (file, raw) => {
  const match = raw.match(/\n([ \t]+)"/);
  indents.set(file, match ? match[1].length : 2);
};
const writeJson = async (file, value) =>
  writeFile(file, `${JSON.stringify(value, null, indents.get(file) ?? 4)}\n`);

const relative = (file) => path.relative(CONSUMER_ROOT, file);

/** Writes a file only when it is absent, so re-running never clobbers anyone's work. */
const writeIfAbsent = async (file, contents) => {
  if (existsSync(file)) {
    console.log(`• ${relative(file)} already exists, left alone`);
    return false;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
  console.log(`✔ wrote ${relative(file)}`);
  return true;
};

/** Appends an entry to a .gitignore, creating it when absent and never duplicating. */
const ignoreInGit = async (file, entries) => {
  const existing = existsSync(file) ? await readFile(file, 'utf8') : '';
  const lines = existing.split('\n').map((line) => line.trim());
  const missing = entries.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return;
  const prefix = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
  await writeFile(file, `${prefix}${missing.join('\n')}\n`);
  console.log(`✔ added ${missing.join(', ')} to ${relative(file)}`);
};

console.log(`Setting up ${path.basename(SUBMODULE_ROOT)} from ${SUBMODULE_REL}\n`);

const templatesDir = await ask('Where should your email templates live?', 'shared/emails', 'templates');
const sourceDir = await ask('Which directory inside it holds the templates?', 'src', 'source');
const outputDir = await ask('Where should the exported HTML go?', 'html', 'output');
const wiredRootScripts = await confirm(
  'Add email:dev and email:build to the root package.json?',
  true,
  'scripts',
);

const templatesRoot = path.resolve(CONSUMER_ROOT, templatesDir);
const manifestPath = path.join(templatesRoot, 'package.json');
const toSubmodule = path.relative(templatesRoot, SUBMODULE_ROOT);
const links = Object.fromEntries(
  Object.entries(LINKED_PACKAGES).map(([name, location]) => [
    name,
    `link:${path.join(toSubmodule, location)}`,
  ]),
);

// The same command from two different working directories: root scripts run at the repo
// root, package scripts run inside the package.
const buildFrom = (fromDir) =>
  `cd ${fromDir} && corepack pnpm install --ignore-scripts && ` +
  `corepack pnpm exec turbo run build ${Object.keys(LINKED_PACKAGES)
    .map((name) => `--filter=${name}`)
    .join(' ')}`;
const buildScript = buildFrom(SUBMODULE_REL);

// Rebuilding the fork before every command keeps it from going stale when the submodule
// moves to another branch. turbo caches it, so a repeat run costs about a tenth of a second.
const rebuild = wiredRootScripts ? 'pnpm -w email:build' : buildFrom(toSubmodule);

const scripts = {
  predev: rebuild,
  dev: `email dev --dir ${sourceDir}`,
  prebuild: rebuild,
  build: `email build --dir ${sourceDir}`,
  preexport: rebuild,
  // --outDir can still be overridden per call; the last one given wins.
  export: `email export --dir ${sourceDir} --outDir ${outputDir}`,
  pretypecheck: rebuild,
  typecheck: 'tsc --noEmit',
};

console.log('');
let manifest;
if (existsSync(manifestPath)) {
  const raw = await readFile(manifestPath, 'utf8');
  rememberIndent(manifestPath, raw);
  manifest = JSON.parse(raw);
  manifest.dependencies = { ...manifest.dependencies, ...links };
  manifest.scripts = { ...scripts, ...manifest.scripts };
  console.log(`• ${relative(manifestPath)} already exists, added the links`);
} else {
  manifest = {
    name: path.basename(templatesRoot).replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
    version: '0.0.1',
    private: true,
    type: 'module',
    scripts,
    dependencies: { ...links, react: REACT_VERSION, 'react-dom': REACT_VERSION },
    devDependencies: {
      '@types/react': REACT_VERSION,
      '@types/react-dom': REACT_VERSION,
      typescript: '^5',
    },
  };
  await mkdir(templatesRoot, { recursive: true });
  console.log(`✔ wrote ${relative(manifestPath)}`);
}
manifest.dependencies = Object.fromEntries(
  Object.entries(manifest.dependencies).sort(([a], [b]) => a.localeCompare(b)),
);
await writeJson(manifestPath, manifest);

await writeIfAbsent(
  path.join(templatesRoot, 'tsconfig.json'),
  `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        skipLibCheck: true,
        isolatedModules: true,
      },
      // react-email.config.ts has to be in the project: left out, an editor opens it with
      // default settings, where moduleResolution ignores exports maps and 'react-email/config'
      // appears unresolvable.
      include: [
        'react-email.config.ts',
        `${sourceDir}/**/*.ts`,
        `${sourceDir}/**/*.tsx`,
        `${sourceDir}/**/*.d.ts`,
      ],
    },
    null,
    4,
  )}\n`,
);

await ignoreInGit(path.join(templatesRoot, '.gitignore'), ['/node_modules', `/${outputDir}`]);

await writeIfAbsent(
  path.join(templatesRoot, 'react-email.config.ts'),
  `import { scssModules } from "@react-email/scss-plugin";
import { defineConfig } from "react-email/config";

export default defineConfig({
    esbuild: {
        // Compiles *.module.scss while templates are bundled. sass stays in this
        // process and is never bundled into a template, where it would not survive.
        plugins: [scssModules()],
    },
});
`,
);

await writeIfAbsent(
  path.join(templatesRoot, sourceDir, 'scss-modules.d.ts'),
  `/**
 * \`*.module.scss\` imports are turned into a module by @react-email/scss-plugin during
 * bundling: the compiled CSS plus a map of local class names to scoped ones.
 */
declare module "*.module.scss" {
    const classes: Record<string, string>;
    export const css: string;
    export default classes;
}
`,
);

await writeIfAbsent(
  path.join(templatesRoot, sourceDir, 'welcome.module.scss'),
  `$brand: #663399;
$ink: #1f2933;

.heading {
    color: $brand;
    font-size: 24px;
    margin: 0 0 16px;
}

.body {
    color: $ink;
    font-size: 14px;
    line-height: 24px;
}

// Not inlinable, so this lands in a <style> in <Head>. Many clients drop it.
@media (max-width: 600px) {
    .heading {
        font-size: 20px;
    }
}
`,
);

await writeIfAbsent(
  path.join(templatesRoot, sourceDir, 'welcome.tsx'),
  `import { Body, Container, Head, Heading, Html, Preview, Scss, Text } from "react-email";

import styles, { css } from "./welcome.module.scss";

export interface WelcomeProps {
    name: string;
}

export default function Welcome({ name = "World" }: WelcomeProps) {
    return (
        <Scss sheets={[css]}>
            <Html>
                <Head />
                <Preview>Hello {name}</Preview>
                <Body>
                    <Container>
                        <Heading className={styles.heading}>Hello {name}</Heading>
                        <Text className={styles.body}>
                            Edit this template in ${path.join(templatesDir, sourceDir, 'welcome.tsx')}.
                        </Text>
                    </Container>
                </Body>
            </Html>
        </Scss>
    );
}
`,
);

if (wiredRootScripts) {
  const rootManifestPath = path.join(CONSUMER_ROOT, 'package.json');
  const raw = await readFile(rootManifestPath, 'utf8');
  rememberIndent(rootManifestPath, raw);
  const rootManifest = JSON.parse(raw);

  // Only assume turbo when the consumer already uses it.
  const usesTurbo = existsSync(path.join(CONSUMER_ROOT, 'turbo.json'));
  rootManifest.scripts ??= {};
  rootManifest.scripts['email:dev'] = usesTurbo
    ? `turbo run dev --filter=${manifest.name}`
    : `pnpm --filter ${manifest.name} dev`;
  rootManifest.scripts['email:build'] = buildScript;
  await writeJson(rootManifestPath, rootManifest);
  console.log('✔ added email:dev and email:build to the root package.json');
}

console.log(`
Add ${templatesDir} to your workspace if it is not covered yet, then:

  pnpm install
${
  wiredRootScripts
    ? '  pnpm email:dev       # preview on :3000'
    : `  pnpm --filter ${manifest.name} dev`
}

The fork is rebuilt by ${templatesDir}'s pre* scripts, so it never goes stale when the
submodule moves to another branch. The first build takes about half a minute; turbo caches
every one after that.
`);

rl?.close();
