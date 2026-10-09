import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { DURATION_MS } from './scenario.js';
import { startServer } from './server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { version } = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
const config = {
  themes: ['light', 'dark'],
  pages: ['record', 'pd', 'trigger', 'settings'],
  output: 'docs/screenshots',
  languages: ['zh-CN', 'zh-TW', 'en', 'ja'],
};
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'npm run showcase:capture -- [--language zh-CN,zh-TW,en,ja] [--theme light,dark] [--page record,pd,trigger,settings] [--output directory]',
  );
  process.exit(0);
}
for (let i = 0; i < args.length; i += 2) {
  const [flag, value] = args.slice(i, i + 2);
  if (!value || !['--theme', '--page', '--output', '--language'].includes(flag))
    throw new Error(`Invalid capture option: ${flag}`);
  if (flag === '--output') config.output = value;
  else {
    const key = flag === '--theme' ? 'themes' : flag === '--language' ? 'languages' : 'pages';
    const choices = value.split(',');
    if (choices.some((choice) => !config[key].includes(choice))) throw new Error(`Invalid ${flag}: ${value}`);
    config[key] = [...new Set(choices)];
  }
}

let browser;
let server;
const faults = [];
const output = resolve(ROOT, config.output);
async function settled(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((accept) => requestAnimationFrame(() => requestAnimationFrame(accept)));
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(1, 799);
  await page.waitForFunction(() => window.__SHOWCASE__.diagnostics().seq === window.__WITRN_STREAM__().seq);
  await page.waitForFunction(() => !document.querySelector('#toast-region .toast'));
  assert.deepEqual(await page.evaluate(() => window.__SHOWCASE__.diagnostics().errors), []);
  const stream = await page.evaluate(() => window.__WITRN_STREAM__());
  assert.equal(stream.failed, false);
  assert.equal(stream.streamErrors, 0);
  assert.equal(faults.length, 0, faults.join('\n'));
  for (const id of ['minimize', 'maximize', 'close']) {
    assert.equal(await page.locator(`#decorum-tb-${id} .fi`).count(), 1, `Missing ${id} control icon`);
  }
}
async function command(page, id) {
  await page.locator(`#${id}`).click();
  await page.waitForFunction(() => !document.getElementById('btn-km-pdm-open').disabled);
}
try {
  await mkdir(output, { recursive: true });
  server = await startServer();
  browser = await chromium.launch({ headless: true });
  for (const language of config.languages) {
    await mkdir(resolve(output, language), { recursive: true });
    for (const theme of config.themes) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        locale: language,
        timezoneId: 'Asia/Hong_Kong',
        colorScheme: theme,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => faults.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') faults.push(message.text());
      });
      await page.goto(`${server.url}/app/?capture=1&theme=${theme}&language=${language}`);
      await page.waitForFunction(
        () => !document.getElementById('btn-connect').disabled && !!document.getElementById('tab-monitor'),
      );
      await page.locator('#device-select').selectOption('showcase:km003c', { force: true });
      await page.locator('#btn-connect').click();
      await page.waitForFunction(
        () => window.__SHOWCASE__.diagnostics().connected && !document.getElementById('btn-record-toggle').disabled,
      );
      await page.locator('#btn-temp-toggle').click();
      await page.locator('#btn-record-toggle').click();
      await page.waitForFunction(() => window.__SHOWCASE__.diagnostics().segment > 0);
      await page.evaluate((duration) => window.__SHOWCASE__.advance(duration), DURATION_MS);
      // Visit actual controls so all views render through the same paths used by the desktop app.
      for (const view of config.pages) {
        if (view === 'settings') {
          await page.locator('#btn-settings-tab').click();
          await page.waitForFunction(() => document.getElementById('about-version').textContent !== '--');
          assert.equal(await page.locator('#about-version').textContent(), `v${version}`);
        } else {
          // Re-entering monitor runs its normal visibility refresh, including throttled statistics.
          if (view === 'record') await page.locator('#tab-pd').click();
          await page.locator(`#tab-${view === 'record' ? 'monitor' : view}`).click();
        }
        if (view === 'record') {
          await page.waitForFunction(() => document.querySelector('.chart-container.has-data canvas') !== null);
          await page.waitForFunction(async () => {
            const { state } = await import('/state.js');
            const average = state.stats.voltage.sum / state.stats.voltage.count;
            const lastX = state.chartSeries.x.at(-1);
            return (
              document.getElementById('avg-voltage').textContent === average.toFixed(3) &&
              document.getElementById('rt-energy').textContent === state.energy.wh.toFixed(4) &&
              state.mainChart.data[0].at(-1) === lastX &&
              state.navigatorChart.data[0].at(-1) === lastX
            );
          });
          assert.notEqual(await page.locator('#rt-temp').textContent(), '--');
          assert.match(await page.locator('#record-duration').textContent(), /02:00/);
        }
        if (view === 'pd') {
          await page.locator('#pd-list').evaluate((list) => {
            list.scrollTop = 0;
          });
          await page.locator('.pd-row[data-index="2"]').click();
          await page.waitForFunction(
            () => !document.getElementById('pd-detail-body').hidden && document.querySelector('#pd-detail-body table'),
          );
        }
        if (view === 'trigger') {
          await command(page, 'btn-km-pdm-open');
          await command(page, 'btn-km-scan');
          await command(page, 'btn-km-read-pdo');
          await page.locator('.trigger-pdo-row').filter({ hasText: '#5' }).click();
          await command(page, 'btn-km-trigger');
          assert.equal(await page.locator('.trigger-pdo-row').count(), 6);
        }
        await settled(page);
        assert.equal(await page.locator('html').getAttribute('lang'), language);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
          false,
          `${language}/${theme}/${view}: viewport overflow`,
        );
        const path = resolve(output, language, `${theme}-${view}.png`);
        await page.screenshot({ path, animations: 'disabled' });
        console.log(`${theme}/${view}: ${path}`);
      }
      await context.close();
    }
  }
} catch (error) {
  if (faults.length) console.error(faults.join('\n'));
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
