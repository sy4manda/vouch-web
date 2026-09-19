// Turns the single-file build into a page fragment (no doctype/html/head/body) with Google Fonts.
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync('dist-demo/index.html', 'utf8');
const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
const js = [...html.matchAll(/<script type="module"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
if (!css || !js) throw new Error('build output not as expected');
const out = `<title>Vouch Demo</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400..900&family=Source+Serif+4:opsz,wght@8..60,400..700&display=swap">
<style>${css}</style>
<div id="root"></div>
<script type="module">${js}</script>
`;
writeFileSync('dist-demo/vouch-demo.html', out);
console.log('vouch-demo.html', (out.length / 1024).toFixed(0) + ' KB');
