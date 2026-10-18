import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOCK_CLASSES, LOCKS } from '../src/db/locks.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return sourceFiles(file);
    return /\.(ts|js|mjs)$/.test(name) ? [file] : [];
  });
}

describe('advisory locks', () => {
  const all = [...Object.values(LOCKS), ...Object.values(LOCK_CLASSES)];

  it('gives every lock its own number, whichever key space it is in', () => {
    expect(new Set(all).size).toBe(all.length);
  });

  it('keeps lock classes within a 32-bit integer (the two-key form takes int4)', () => {
    for (const id of Object.values(LOCK_CLASSES)) {
      expect(Number.isInteger(id) && id > 0 && id <= 2 ** 31 - 1).toBe(true);
    }
  });

  it('keeps the numbers in src/db/locks.ts only', () => {
    // A literal elsewhere would bypass the registry (and its uniqueness check).
    const literal = new RegExp(
      `\\b(${all.map((n) => `${n}|${String(n).replace(/^(\d{3})/, '$1_')}`).join('|')})\\b`,
    );
    const offenders = ['src', 'test', 'scripts']
      .flatMap((dir) => sourceFiles(path.join(root, dir)))
      .filter((file) => !file.endsWith(path.join('src', 'db', 'locks.ts')))
      .filter((file) => !file.endsWith('locks.test.ts'))
      .filter((file) => literal.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });
});
