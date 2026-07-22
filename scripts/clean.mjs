import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedDirectories = ['.vite', 'out'];

for (const directory of generatedDirectories) {
  const target = path.resolve(projectRoot, directory);
  if (path.dirname(target) !== projectRoot) {
    throw new Error(`Refusing to clean path outside the project root: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}

console.log(`Removed generated output: ${generatedDirectories.join(', ')}`);
