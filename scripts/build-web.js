#!/usr/bin/env node
// Bundles the React front end (web/src) into one self-hosted, minified file: public/app/app.js.
// Usage: node scripts/build-web.js [--watch]
'use strict';
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(ROOT, 'web/src/main.tsx')],
  outfile: path.join(ROOT, 'public/app/app.js'),
  bundle: true,
  minify: !watch && !process.env.NO_MINIFY,
  sourcemap: watch ? 'inline' : false,
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  logLevel: 'info',
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('Watching web/src for changes…');
  } else {
    const r = await esbuild.build({ ...options, metafile: true });
    const bytes = Object.values(r.metafile.outputs)[0].bytes;
    console.log(`public/app/app.js ${(bytes / 1024).toFixed(0)} KB`);
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
