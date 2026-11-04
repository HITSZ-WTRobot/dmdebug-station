import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
const root = resolve(import.meta.dirname, '..');
let html = await readFile(resolve(root, 'dist/index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)];
if (scripts.length !== 1) throw new Error('Portable export requires exactly one bundled entry script');
for (const match of scripts) {
  const source = await readFile(resolve(root, 'dist/assets', basename(match[1])), 'utf8');
  html = html.replace(match[0], () => `<script type="module">${source.replace(/<\/script/gi, '<\\/script')}</script>`);
}
for (const match of [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g)]) {
  const css = await readFile(resolve(root, 'dist/assets', basename(match[1])), 'utf8');
  html = html.replace(match[0], () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`);
}
if (/<(?:script|link)\b[^>]*(?:src|href)="\.?\/?assets\//.test(html)) throw new Error('Portable export still references external build assets');
await mkdir(resolve(root, 'web'), { recursive: true });
await Promise.all(['index.html', '串口.html'].map(name => writeFile(resolve(root, 'web', name), html)));
console.log('Portable v2 pages exported: web/index.html, web/串口.html');
