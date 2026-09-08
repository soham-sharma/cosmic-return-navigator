/**
 * One-off repair: undo UTF-8-read-as-CP1252 mojibake, and strip BOMs.
 *
 * A bulk PowerShell rewrite during the Zod 4 migration read UTF-8 bytes as
 * CP1252 and wrote them back as UTF-8, which corrupted every em dash into the
 * three-character sequence U+00E2 U+20AC U+201D and prepended a UTF-8 BOM.
 *
 * A whole-file inverse transform is NOT safe here, because the same files were
 * later edited with correctly-encoded UTF-8 — so the repair is a targeted
 * replacement of the specific corrupt sequences that actually occur, verified
 * by enumerating them first (see scripts/seq.mjs).
 *
 * Kept in the repo as a record of the fix. Idempotent and safe to re-run.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Corrupt sequence -> intended character.
 * Ordered longest-first so no replacement can eat another's prefix.
 */
const REPLACEMENTS = [
  ['—', '—'], // em dash
  ['–', '–'], // en dash
  ['’', '’'], // right single quote
  ['“', '“'], // left double quote
  ['”', '”'], // right double quote
  ['€', '€'], // euro sign
  [' ', ' '], // non-breaking space -> plain space
];

const files = [];
for (const root of ['src', 'tests', 'scripts']) {
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|mts|mjs|json|md)$/.test(entry.name)) files.push(full);
    }
  })(root);
}

let repaired = 0;
let debommed = 0;

for (const file of files) {
  const original = fs.readFileSync(file, 'utf8');
  let text = original;

  for (const [bad, good] of REPLACEMENTS) {
    text = text.split(bad).join(good);
  }

  // PowerShell's `-Encoding utf8` writes a BOM; the toolchain does not want one.
  let strippedBom = false;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
    strippedBom = true;
  }

  if (text === original) continue;

  fs.writeFileSync(file, text, { encoding: 'utf8' });
  if (strippedBom) debommed += 1;
  repaired += 1;
  console.log(`FIXED ${file}${strippedBom ? ' (BOM stripped)' : ''}`);
}

console.log(`\n${repaired} file(s) rewritten, ${debommed} BOM(s) removed.`);
