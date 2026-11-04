import { copyFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'src-tauri/target/release/dm-debug-station.exe');
await stat(source);
await copyFile(source, resolve(root, 'DMDebugStation.exe'));
console.log('Updated DMDebugStation.exe from the current Tauri release build');
