import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'esbuild';
import { createJiti } from 'jiti';

export interface ReactEmailConfig {
  esbuild?: {
    /**
     * Extra esbuild plugins applied when templates are bundled, after the ones
     * React Email adds itself. Use this to teach the bundler about file types it
     * does not handle, such as `.scss` or `.graphql`.
     */
    plugins?: Plugin[];
    /**
     * Extra packages to leave unbundled. Necessary for dependencies that do not
     * survive bundling, such as compiled-to-JS toolchains that load their own
     * assets at runtime.
     */
    external?: string[];
  };
}

/** Identity helper that gives a config file type checking and completions. */
export const defineConfig = (config: ReactEmailConfig): ReactEmailConfig =>
  config;

const CONFIG_FILENAMES = [
  'react-email.config.ts',
  'react-email.config.mts',
  'react-email.config.js',
  'react-email.config.mjs',
];

const cache = new Map<string, ReactEmailConfig>();

/**
 * Loads `react-email.config.*` from `projectPath`, if one exists. Returns an
 * empty config when it does not, so callers can always spread from it.
 *
 * Both the CLI and the preview server call this, each inside its own process —
 * esbuild plugins are functions and cannot be passed between them.
 */
export const loadUserConfig = async (
  projectPath: string = process.cwd(),
): Promise<ReactEmailConfig> => {
  const cached = cache.get(projectPath);
  if (cached) return cached;

  const jiti = createJiti(projectPath);
  let config: ReactEmailConfig = {};

  for (const filename of CONFIG_FILENAMES) {
    const configPath = path.resolve(projectPath, filename);
    if (!fs.existsSync(configPath)) continue;

    const loaded = await jiti.import<ReactEmailConfig | { default: ReactEmailConfig }>(configPath);
    config = 'default' in loaded ? loaded.default : loaded;
    break;
  }

  cache.set(projectPath, config);
  return config;
};
