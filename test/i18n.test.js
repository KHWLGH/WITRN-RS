import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { formatCsvChunks, formatCsvHeader, snapshotCsvColumns } from '../src/csv-codec.js';
import { computeCsvImport } from '../src/csv-import-core.js';
import {
  applyLanguage,
  dictionaries,
  errorText,
  getResolvedLanguage,
  initI18n,
  normalizeLanguagePreference,
  onLanguageChange,
  resolveLanguage,
  resolveLocale,
  t,
  translateDocument,
} from '../src/i18n.js';
import { buildPdCaptureFile, parsePdCaptureFile } from '../src/pd-model.js';
import { emptyChartColumns, state } from '../src/state.js';

test('locale mapping uses script before region and rejects invalid language prefixes', () => {
  const cases = {
    zh: 'zh-CN',
    zh_CN: 'zh-CN',
    'ZH-sg.UTF-8': 'zh-CN',
    'zh-Hans-TW': 'zh-CN',
    'zh-hant-CN': 'zh-TW',
    zh_TW: 'zh-TW',
    'zh-HK': 'zh-TW',
    'zh-mo@variant': 'zh-TW',
    'ja_JP.UTF-8': 'ja',
    JA: 'ja',
    en_US: 'en',
    fr_FR: 'en',
    'C.UTF-8': 'en',
    POSIX: 'en',
    '': 'en',
    'not a locale': 'en',
    zhgarbage: 'en',
    japanese: 'en',
    'zh-!': 'en',
  };
  for (const [locale, language] of Object.entries(cases)) assert.equal(resolveLocale(locale), language, locale);
  assert.equal(resolveLocale(null), 'en');
  assert.equal(resolveLocale(undefined), 'en');
  for (const value of [null, undefined, '', 'fr', 'zh-cn', {}, 1])
    assert.equal(normalizeLanguagePreference(value), 'auto');
  for (const language of Object.keys(dictionaries)) assert.equal(resolveLanguage(language, 'fr_FR'), language);
  assert.equal(resolveLanguage('auto', 'ja_JP'), 'ja');
  assert.equal(resolveLanguage('invalid', 'zh_HK'), 'zh-TW');
});

test('dictionaries have the same keys and interpolation parameters', () => {
  const keys = Object.keys(dictionaries.en).sort();
  const params = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const [language, dictionary] of Object.entries(dictionaries)) {
    assert.deepEqual(Object.keys(dictionary).sort(), keys, language);
    for (const key of keys) {
      assert.ok(dictionary[key].trim(), `${language}.${key}`);
      assert.deepEqual(params(dictionary[key]), params(dictionaries.en[key]), `${language}.${key}`);
    }
  }
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)) assert.ok(dictionaries.en[match[1]], match[1]);
  assert.match(html, /<html lang="en">/);
});

test('switching preserves recording, data, range and connection while notifying subscribers', async () => {
  const settings = state.settings;
  const columns = state.chartSeries;
  state.isConnected = true;
  state.isRecording = true;
  state.settings.rangeStart = 123;
  state.settings.rangeEnd = 789;
  const changed = [];
  const off = onLanguageChange((language) => changed.push(language));
  const snapshot = snapshotCsvColumns(columns, { sampleRate: 250, startTime: 0 });
  const header = formatCsvHeader(snapshot);
  for (const language of Object.keys(dictionaries)) {
    await applyLanguage(language);
    assert.equal(getResolvedLanguage(), language);
    assert.equal(state.settings, settings);
    assert.equal(state.chartSeries, columns);
    assert.equal(state.isConnected, true);
    assert.equal(state.isRecording, true);
    assert.equal(state.settings.rangeStart, 123);
    assert.equal(state.settings.rangeEnd, 789);
    assert.equal(formatCsvHeader(snapshot), header);
    assert.ok(t('pdCounter', { count: 0 }).includes('0'));
    assert.ok(t('pdCounter', { count: 1 }).includes('1'));
    assert.ok(t('pdCounter', { count: 2 }).includes('2'));
    assert.equal(errorText({ code: 'sampleIntervalInvalid', params: {} }), t('sampleIntervalInvalid'));
    assert.equal(errorText('external plugin diagnostic'), 'external plugin diagnostic');
  }
  off();
  assert.deepEqual(changed, Object.keys(dictionaries));
  await applyLanguage('en');
  assert.equal(t('csvImported', { count: 42 }), 'Imported 42 data points');
  assert.equal(t('unknown.translation.key'), 'unknown.translation.key');
});

test('native locale is authoritative; unavailable native locale uses the first WebView language', async () => {
  const windowBefore = globalThis.window;
  globalThis.window = { __TAURI__: { core: { invoke: async () => 'zh-Hant-CN' } } };
  state.settings.language = 'auto';
  assert.equal(await initI18n(), 'zh-TW');
  window.__TAURI__.core.invoke = async () => 'C';
  assert.equal(await initI18n(), 'en');
  window.__TAURI__.core.invoke = async () => {
    throw new Error('unavailable');
  };
  assert.equal(await initI18n(), resolveLocale(navigator.languages?.[0] || navigator.language));
  state.settings.language = 'ja';
  assert.equal(await initI18n(), 'ja');
  globalThis.window = windowBefore;
});

test('static markers update text and accessible attributes in place', async () => {
  const attrs = new Map([
    ['data-i18n', 'language'],
    ['data-i18n-title', 'languageHint'],
  ]);
  const element = {
    textContent: '',
    getAttribute: (key) => attrs.get(key),
    setAttribute: (key, value) => attrs.set(key, value),
  };
  const root = {
    querySelectorAll: (selector) => (selector === '[data-i18n]' || selector === '[data-i18n-title]' ? [element] : []),
  };
  await applyLanguage('ja');
  translateDocument(root);
  assert.equal(element.textContent, dictionaries.ja.language);
  assert.equal(attrs.get('title'), dictionaries.ja.languageHint);
});

test('English is the missing-translation fallback and quantities use matching singular keys', async () => {
  const translated = dictionaries.ja.csvImported;
  try {
    delete dictionaries.ja.csvImported;
    await applyLanguage('ja');
    assert.equal(t('csvImported', { count: 2 }), dictionaries.en.csvImported.replace('{count}', '2'));
    assert.equal(t('toString'), 'toString');
    assert.match(errorText({ code: 'newUnknownError', detail: 'original diagnostic' }), /original diagnostic/);
  } finally {
    dictionaries.ja.csvImported = translated;
  }
  for (const language of Object.keys(dictionaries)) {
    await applyLanguage(language);
    for (const key of Object.keys(dictionaries.en).filter((key) => key.endsWith('One'))) {
      const plural = key.slice(0, -3);
      assert.ok(dictionaries.en[plural], key);
      assert.equal(t(plural, { count: 1 }), t(key, { count: 1 }), `${language}.${key}`);
      for (const count of [0, 2]) {
        assert.equal(t(plural, { count }), dictionaries[language][plural].replace('{count}', String(count)));
      }
    }
  }
});

test('CSV and PD capture serialization round-trip between every pair of languages', async () => {
  const startTime = 1700000000000;
  const columns = emptyChartColumns(3);
  const values = {
    x: [0, 0.25, 5.25],
    timestamps: [startTime, startTime + 250, startTime + 5250],
    voltage: [5.123456789, 9, 20],
    current: [1.25, -0.5, 2],
    power: [6.40432098625, -4.5, 40],
    temp: [23.5, Number.NaN, 25],
    dp: [0.6, 0.7, 1],
    dn: [0.6, 0.7, 1],
    cc1: [1, 1, 1],
    cc2: [0, 0, 0],
    recordingSegments: [1, 1, 2],
    sampleIntervals: [250, 250, 5000],
  };
  for (const [key, value] of Object.entries(values)) columns[key].set(value);
  const entries = [
    {
      t: startTime,
      sop: 'SOP',
      type: 'Source_Capabilities',
      role: 'SRC',
      summary: '9V 2A',
      bytes: [1, 2, 3],
      vbus: 9,
      ibus: -0.5,
    },
    { t: startTime + 1, divider: true },
  ];
  let baselineCsv;
  let baselinePd;
  for (const from of Object.keys(dictionaries)) {
    await applyLanguage(from);
    const csv = [...formatCsvChunks(snapshotCsvColumns(columns, { sampleRate: 250, startTime, withTemp: true }))].join(
      '',
    );
    const capture = buildPdCaptureFile(entries);
    if (baselineCsv === undefined) {
      baselineCsv = csv;
      baselinePd = capture.entries;
    }
    assert.equal(csv, baselineCsv);
    assert.deepEqual(capture.entries, baselinePd);
    for (const to of Object.keys(dictionaries)) {
      await applyLanguage(to);
      const imported = computeCsvImport(csv, { fallbackStartTime: startTime, signedCurrent: true });
      for (const [key, value] of Object.entries(values))
        assert.deepEqual([...imported.columns[key].view()], value, `${from} -> ${to}: ${key}`);
      const parsed = parsePdCaptureFile(JSON.parse(JSON.stringify(capture)));
      assert.equal(parsed.ok, true);
      assert.deepEqual(parsed.entries, entries, `${from} -> ${to}: PD`);
    }
  }
});

test('native file dialog titles and filters use the selected language', async () => {
  const before = globalThis.window;
  const calls = [];
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: async (command, args) => {
          calls.push({ command, args });
          return null;
        },
      },
    },
  };
  const { pickExportFile, pickImportFile, pickPdExportFile } = await import('../src/file-io.js');
  try {
    for (const language of Object.keys(dictionaries)) {
      await applyLanguage(language);
      await pickExportFile('test.csv');
      await pickImportFile();
      await pickPdExportFile('test.json');
      const [csvExport, csvImport, pdExport] = calls.splice(0);
      assert.deepEqual(csvExport.args, { defaultName: 'test.csv', title: t('exportCsv'), filterName: t('csvFile') });
      assert.deepEqual(csvImport.args, { title: t('importCsv'), filterName: t('csvFile') });
      assert.deepEqual(pdExport.args, { defaultName: 'test.json', title: t('pdExportTitle'), filterName: t('pdFile') });
    }
  } finally {
    globalThis.window = before;
  }
});
