import { build } from "esbuild";
await build({entryPoints:["src/preview/browser/relight/viewer.ts"],outfile:"dist/creature-preview.js",bundle:true,format:"iife",platform:"browser",target:"es2022",minify:true,legalComments:"eof"});
await build({entryPoints:["src/worker/media.ts"],outfile:"dist/creature-media-worker.js",bundle:true,format:"esm",platform:"node",target:"node22",packages:"external"});
