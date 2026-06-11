import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const opts = {
  entryPoints: ['src/main.jsx'],
  bundle: true,
  outfile: '../client/dist/app.js',
  format: 'iife',
  target: 'es2019',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  // CEP pages have Node injected; React/lucide are bundled into the panel asset.
  loader: { '.css': 'css' },
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
} else {
  await esbuild.build(opts);
}
