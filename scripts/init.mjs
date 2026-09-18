#!/usr/bin/env node
/**
 * Wires this fork into the repository that includes it as a git submodule.
 *
 * Run it from the consuming repository's root, after adding the submodule:
 *
 *     node tools/react-email/scripts/init.mjs
 *
 * It links the fork's packages into the templates package, writes the config and type
 * declaration the SCSS support needs, and optionally adds the email scripts to the root
 * package.json. Plain Node with no dependencies, so it works before anything is installed.
 *
 * Every answer can be given up front, which also makes it usable without a terminal:
 *
 *     node tools/react-email/scripts/init.mjs --templates=shared/emails --source=src \
 *       --output=html --scripts
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

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

/** Appends an entry to a .gitignore, creating it when absent and never duplicating. */
const ignoreInGit = async (file, entry) => {
  const existing = existsSync(file) ? await readFile(file, 'utf8') : '';
  if (existing.split('\n').some((line) => line.trim() === entry)) return;
  await writeFile(file, existing && !existing.endsWith('\n') ? `${existing}\n${entry}\n` : `${existing}${entry}\n`);
  console.log(`✔ added ${entry} to ${path.relative(CONSUMER_ROOT, file)}`);
};
const writeJson = async (file, value) =>
  writeFile(file, `${JSON.stringify(value, null, indentOf(file) ?? 2)}\n`);

/** Keeps a file's existing indentation instead of reformatting the whole thing. */
const indentCache = new Map();
const indentOf = (file) => indentCache.get(file);
const rememberIndent = (file, raw) => {
  const match = raw.match(/\n([ \t]+)"/);
  indentCache.set(file, match ? match[1].length : 2);
};

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
  const answer = (await rl.question(`${question} [${fallback ? 'Y/n' : 'y/N'}] `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer.startsWith('y');
};

console.log(`Setting up ${path.basename(SUBMODULE_ROOT)} from ${SUBMODULE_REL}\n`);

const templatesDir = await ask('Where do your email templates live?', 'shared/emails', 'templates');
const templatesRoot = path.resolve(CONSUMER_ROOT, templatesDir);
const templatesManifestPath = path.join(templatesRoot, 'package.json');

if (!existsSync(templatesManifestPath)) {
  console.error(`\nNo package.json at ${path.join(templatesDir, 'package.json')}.`);
  console.error('Create the templates package first, then run this again.');
  rl?.close();
  process.exit(1);
}

const templatesRaw = await readFile(templatesManifestPath, 'utf8');
rememberIndent(templatesManifestPath, templatesRaw);
const templatesManifest = JSON.parse(templatesRaw);

// link: paths are resolved relative to the package that declares them.
const toSubmodule = path.relative(templatesRoot, SUBMODULE_ROOT);
templatesManifest.dependencies ??= {};
for (const [name, location] of Object.entries(LINKED_PACKAGES)) {
  templatesManifest.dependencies[name] = `link:${path.join(toSubmodule, location)}`;
}
templatesManifest.dependencies = Object.fromEntries(
  Object.entries(templatesManifest.dependencies).sort(([a], [b]) => a.localeCompare(b)),
);
await writeJson(templatesManifestPath, templatesManifest);
console.log(`\n✔ linked ${Object.keys(LINKED_PACKAGES).join(', ')} into ${templatesDir}`);

const sourceDir = await ask('Which directory inside it holds the templates?', 'src', 'source');
await mkdir(path.join(templatesRoot, sourceDir), { recursive: true });

const outputDir = await ask('Where should the exported HTML go?', 'html', 'output');

const configPath = path.join(templatesRoot, 'react-email.config.ts');
if (existsSync(configPath)) {
  console.log('• react-email.config.ts already exists, left alone');
} else {
  await writeFile(
    configPath,
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
  console.log('✔ wrote react-email.config.ts');
}

const declarationPath = path.join(templatesRoot, sourceDir, 'scss-modules.d.ts');
if (existsSync(declarationPath)) {
  console.log('• scss-modules.d.ts already exists, left alone');
} else {
  await writeFile(
    declarationPath,
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
  console.log(`✔ wrote ${path.join(sourceDir, 'scss-modules.d.ts')}`);
}

await ignoreInGit(path.join(templatesRoot, '.gitignore'), `/${outputDir}`);

const buildScript =
  `cd ${SUBMODULE_REL} && corepack pnpm install --ignore-scripts && ` +
  `corepack pnpm exec turbo run build ${Object.keys(LINKED_PACKAGES)
    .map((name) => `--filter=${name}`)
    .join(' ')}`;

const templatesScripts = (templatesManifest.scripts ??= {});
for (const [name, command] of Object.entries({
  dev: `email dev --dir ${sourceDir}`,
  build: `email build --dir ${sourceDir}`,
  // --outDir can still be overridden per call; the last one given wins.
  export: `email export --dir ${sourceDir} --outDir ${outputDir}`,
})) {
  templatesScripts[name] ??= command;
}
await writeJson(templatesManifestPath, templatesManifest);

const wiredRootScripts = await confirm(
  '\nAdd email:dev and email:build to the root package.json?',
  true,
  'scripts',
);
if (wiredRootScripts) {
  const rootManifestPath = path.join(CONSUMER_ROOT, 'package.json');
  const rootRaw = await readFile(rootManifestPath, 'utf8');
  rememberIndent(rootManifestPath, rootRaw);
  const rootManifest = JSON.parse(rootRaw);

  // Only assume turbo when the consumer already uses it.
  const usesTurbo = existsSync(path.join(CONSUMER_ROOT, 'turbo.json'));
  const templatesName = templatesManifest.name ?? path.basename(templatesRoot);

  rootManifest.scripts ??= {};
  rootManifest.scripts['email:dev'] = usesTurbo
    ? `turbo run dev --filter=${templatesName}`
    : `pnpm --filter ${templatesName} dev`;
  rootManifest.scripts['email:build'] = buildScript;
  await writeJson(rootManifestPath, rootManifest);
  console.log('✔ added email:dev and email:build to the root package.json');
  console.log('\n  Run the preview with: pnpm email:dev');
} else {
  console.log('\n  Skipped. Build the fork yourself with:');
  console.log(`    ${buildScript}`);
}

console.log(`
Remaining, once you are happy with the manifests:

  pnpm install
${
  wiredRootScripts
    ? '  pnpm email:build     # first run compiles the fork, later runs are cached\n  pnpm email:dev       # preview on :3000'
    : `  ${buildScript}\n  pnpm --filter ${templatesManifest.name ?? path.basename(templatesRoot)} dev`
}

Hook that build into the templates package's pre* scripts if you want it to stay current
automatically when the submodule moves to another branch.
`);

rl?.close();
