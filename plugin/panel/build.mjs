import * as esbuild from 'esbuild';
import { buildOptions } from './build-options.mjs';

const watch = process.argv.includes('--watch');
const opts = buildOptions();

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
} else {
  await esbuild.build(opts);
}
