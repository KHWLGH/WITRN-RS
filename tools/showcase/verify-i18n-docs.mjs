import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const docs = ['README.md', 'README.zh-CN.md', 'README.zh-TW.md', 'README.ja.md'];
for (const language of ['', 'en/', 'zh-TW/', 'ja/']) {
  for (const guide of ['USAGE', 'TEMPERATURE', 'DEVELOPMENT']) docs.push(`docs/${language}${guide}.md`);
}
const anchorCache = new Map();
const markdownCache = new Map(
  await Promise.all(docs.map(async (doc) => [doc, await readFile(resolve(root, doc), 'utf8')])),
);

// Compare coverage by corresponding section, without treating translated prose as identical text.
function sections(markdown) {
  const parts = [];
  let section;
  let fence;
  let table;
  for (const line of markdown.replace(/\r/g, '').split('\n')) {
    if (fence) {
      if (line.startsWith('```')) {
        section.examples.push(fence);
        fence = undefined;
      } else fence.lines.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      section = { title: heading[2], level: heading[1].length, tables: [], bullets: 0, numbered: 0, examples: [] };
      parts.push(section);
      table = undefined;
      continue;
    }
    if (!section) continue;
    if (line.startsWith('```')) {
      fence = { language: line.slice(3).trim() || 'text', lines: [] };
      table = undefined;
      continue;
    }
    if (/^\|.*\|\s*$/.test(line)) {
      if (!table) {
        table = [];
        section.tables.push(table);
      }
      table.push(line.split(/(?<!\\)\|/).length - 2);
    } else table = undefined;
    if (/^\s*[-*]\s+/.test(line)) section.bullets++;
    if (/^\s*\d+\.\s+/.test(line)) section.numbered++;
  }
  assert.ok(!fence, 'unclosed code block');
  return parts;
}

function coverage(section) {
  return {
    level: section.level,
    tables: section.tables,
    bullets: section.bullets,
    numbered: section.numbered,
    examples: section.examples.map((example) => example.language),
  };
}

function exampleText(example) {
  const text = example.lines.join('\n');
  // Comments may be translated; executable Python remains identical.
  return example.language === 'python' ? text.replace(/[ \t]+#.*$/gm, '') : text;
}
async function anchors(path) {
  if (anchorCache.has(path)) return anchorCache.get(path);
  const markdown = (await readFile(path, 'utf8')).replace(/^```[^\n]*\n[\s\S]*?^```/gm, '');
  const ids = new Set();
  const occurrences = new Map();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    // GitHub preserves Unicode letters and leading hyphens left by emoji headings.
    const base = match[1]
      .trim()
      .replace(/<[^>]*>/g, '')
      .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
      .toLowerCase()
      .replace(/\s/g, '-');
    const count = occurrences.get(base) ?? 0;
    occurrences.set(base, count + 1);
    ids.add(base + (count ? `-${count}` : ''));
  }
  for (const match of markdown.matchAll(/\bid=["']([^"']+)["']/g)) ids.add(match[1]);
  anchorCache.set(path, ids);
  return ids;
}

let checkedLinks = 0;
let checkedTranslations = 0;
const failures = [];
const groups = [['README.zh-CN.md', 'README.md', 'README.zh-TW.md', 'README.ja.md']];
for (const guide of ['USAGE', 'TEMPERATURE', 'DEVELOPMENT']) {
  groups.push([`docs/${guide}.md`, ...['en', 'zh-TW', 'ja'].map((language) => `docs/${language}/${guide}.md`)]);
}
for (const [source, ...translations] of groups) {
  const original = sections(markdownCache.get(source));
  for (const doc of translations) {
    try {
      const translated = sections(markdownCache.get(doc));
      assert.equal(translated.length, original.length, `${doc}: section count differs from ${source}`);
      for (const [index, section] of original.entries()) {
        const target = translated[index];
        const context = `${doc}: ${target.title} / ${source}: ${section.title}`;
        assert.deepEqual(coverage(target), coverage(section), `${context}: section coverage differs`);
        for (const [exampleIndex, example] of section.examples.entries()) {
          // Commands, schemas, rules, Python and raw protocol examples are not abridged or localised.
          // Only the annotated device-selector example contains translated UI labels.
          // Actual example-server console output stays in its original language.
          if (example.language !== 'text' || !example.lines[0]?.startsWith('WITRN K2 '))
            assert.equal(
              exampleText(target.examples[exampleIndex]),
              exampleText(example),
              `${context}: example differs`,
            );
        }
      }
      checkedTranslations++;
    } catch (error) {
      failures.push(error.message);
    }
  }
}
for (const doc of docs) {
  const markdown = markdownCache.get(doc);
  const links = [...markdown.matchAll(/\]\(([^)]+)\)/g)].map((match) =>
    match[1].replace(/\s+["'][\s\S]*$/, '').replace(/^<|>$/g, ''),
  );
  links.push(...[...markdown.matchAll(/<img[^>]*\bsrc=["']([^"']+)["']/g)].map((match) => match[1]));
  for (const link of links) {
    if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(link)) continue;
    checkedLinks++;
    const [file, hash] = link.split('#');
    const path = file ? resolve(dirname(resolve(root, doc)), decodeURIComponent(file)) : resolve(root, doc);
    try {
      await readFile(path);
      if (hash && path.endsWith('.md'))
        assert.ok((await anchors(path)).has(decodeURIComponent(hash)), `missing #${hash}`);
    } catch (error) {
      failures.push(`${doc}: ${link}: ${error.message}`);
    }
  }
}
for (const language of ['en', 'zh-CN', 'zh-TW', 'ja']) {
  for (const theme of ['light', 'dark']) {
    for (const view of ['record', 'pd', 'trigger', 'settings']) {
      const path = `docs/screenshots/${language}/${theme}-${view}.png`;
      try {
        const png = await readFile(resolve(root, path));
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      } catch (error) {
        failures.push(`${path}: ${error.message}`);
      }
    }
  }
}
assert.deepEqual(failures, []);
console.log(
  `PASS: ${docs.length} multilingual documents, ${checkedTranslations} aligned translations, ${checkedLinks} relative links/anchors and 32 screenshots`,
);
