import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { dictionaries, resolveLocale } from '../../src/i18n.js';
import { startServer } from './server.mjs';

const languages = ['en', 'zh-CN', 'zh-TW', 'ja'];
const server = await startServer();
const browser = await chromium.launch({ headless: true });
const output = resolve('output/i18n-verification');
await mkdir(output, { recursive: true });
const failures = [];
try {
  const dialogsPage = await browser.newPage({ locale: 'en-US' });
  dialogsPage.on('pageerror', (error) => failures.push(String(error)));
  await dialogsPage.goto(`${server.url}/app/?capture=1&language=en`);
  await dialogsPage.waitForFunction(() => !!document.getElementById('tab-monitor'));
  await dialogsPage.evaluate(async () => {
    const { toast } = await import('/ui/toast.js');
    const { t, errorText } = await import('/i18n.js');
    const { ask } = await import('/ui/dialog.js');
    window.__I18N_TOAST__ = toast.error(() => errorText({ code: 'backendFailure', detail: 'raw diagnostic' }), {
      duration: 0,
      action: { label: () => t('recover'), onClick: () => false },
    });
    window.__I18N_DIALOG__ = ask(() => t('resetPrompt'), { title: () => t('confirmReset'), kind: 'warning' });
  });
  await dialogsPage.locator('dialog[open]').waitFor();
  for (const language of languages) {
    await dialogsPage.evaluate(async (language) => (await import('/i18n.js')).applyLanguage(language), language);
    const dictionary = dictionaries[language];
    assert.equal(await dialogsPage.locator('.fluent-dialog-title').textContent(), dictionary.confirmReset);
    assert.equal(await dialogsPage.locator('.fluent-dialog-body').textContent(), dictionary.resetPrompt);
    assert.equal(await dialogsPage.locator('.fluent-dialog-ok').textContent(), dictionary.ok);
    assert.equal(await dialogsPage.locator('.fluent-dialog-cancel').textContent(), dictionary.cancel);
    assert.equal(
      await dialogsPage.locator('.toast-text').textContent(),
      dictionary.backendFailure.replace('{detail}', 'raw diagnostic'),
    );
    assert.equal(await dialogsPage.locator('.toast-action').textContent(), dictionary.recover);
    assert.equal(await dialogsPage.locator('.toast-close').getAttribute('aria-label'), dictionary.closeNotification);
    assert.equal(await dialogsPage.locator('#tab-monitor').getAttribute('aria-label'), dictionary.monitor);
    assert.equal(await dialogsPage.locator('dialog').getAttribute('aria-labelledby'), 'fluent-dialog-title');
    const deviceName = await dialogsPage.evaluate(async () => {
      const { deviceDisplayName } = await import('/device.js');
      return deviceDisplayName({
        model_name: 'Unknown WITRN device (0716:50FF)',
        display_name: 'legacy name',
        usb_port: '4-4',
        model_description: { code: 'unknownWitrnDevice', params: { vid: '0716', pid: '50FF' } },
        interface_description: { code: 'deviceInterface', params: { index: '2', usage: 'FF00' } },
      });
    });
    assert.equal(
      deviceName,
      `${dictionary.unknownWitrnDevice.replace('{vid}', '0716').replace('{pid}', '50FF')} (USB 4-4) [${dictionary.deviceInterface.replace('{index}', '2').replace('{usage}', 'FF00')}]`,
    );
  }
  await dialogsPage.locator('.fluent-dialog-cancel').click();
  assert.equal(await dialogsPage.evaluate(() => window.__I18N_DIALOG__), false);
  await dialogsPage.close();
  console.log('PASS: open dialog, persistent notification, actions and accessible labels switch in place');
  for (const locale of ['zh-Hans-TW', 'zh-Hant-CN', 'ja-JP', 'fr-FR', 'C']) {
    const page = await browser.newPage({ locale: 'en-US' });
    page.on('pageerror', (error) => failures.push(String(error)));
    await page.goto(`${server.url}/app/?capture=1&language=auto&systemLocale=${locale}`);
    await page.waitForFunction(() => !!document.getElementById('tab-monitor'));
    assert.equal(await page.locator('html').getAttribute('lang'), resolveLocale(locale));
    assert.match(await page.locator('#language-select option[value=auto]').textContent(), /\(.+\)/);
    await page.close();
  }
  for (const theme of ['light', 'dark'])
    for (const [width, height] of [
      [900, 600],
      [1280, 800],
    ]) {
      const context = await browser.newContext({ viewport: { width, height }, locale: 'en-US', colorScheme: theme });
      const page = await context.newPage();
      page.on('pageerror', (error) => failures.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') failures.push(message.text());
      });
      await page.goto(`${server.url}/app/?capture=1&theme=${theme}&language=en`);
      await page.waitForFunction(() => !document.getElementById('btn-connect').disabled);
      await page.locator('#device-select').selectOption('showcase:km003c', { force: true });
      await page.locator('#btn-connect').click();
      await page.waitForFunction(() => window.__SHOWCASE__.diagnostics().connected);
      await page.locator('#btn-record-toggle').click();
      await page.waitForFunction(() => window.__SHOWCASE__.diagnostics().segment > 0);
      await page.evaluate(() => window.__SHOWCASE__.advance(120_000));
      await page.locator('#tab-pd').click();
      await page.locator('#pd-filter').fill('Source');
      await page.locator('.pd-row').first().click();
      await page.locator('.pd-row.selected').waitFor();
      await page.locator('#pd-detail-body:visible').waitFor();
      await page.locator('#tab-trigger').click();
      await page.locator('#btn-km-pdm-open').click();
      await page.waitForFunction(() => !document.getElementById('btn-km-pdm-open').disabled);
      await page.locator('#btn-km-read-pdo').click();
      await page.waitForFunction(() => document.querySelectorAll('.trigger-pdo-row').length > 0);
      await page.locator('#btn-settings-tab').click();
      await page.evaluate(async () => {
        const { state } = await import('/state.js');
        state.settings.rangeStart = 200;
        state.settings.rangeEnd = 800;
        window.__I18N_SNAPSHOT__ = {
          columns: state.chartSeries,
          chart: state.mainChart,
          length: state.chartSeries.x.length,
          energy: state.energy.wh,
          selected: document.querySelector('.pd-row.selected')?.dataset.index,
          generation: window.__WITRN_STREAM__().generation,
          pdCaptureButton: document.getElementById('btn-pd-pause'),
          pdCaptureIcon: document.querySelector('#btn-pd-pause i'),
          pdCaptureLabel: document.querySelector('#btn-pd-pause span'),
          pdDetail: document.getElementById('pd-detail-body').textContent,
        };
      });
      for (const language of languages) {
        await page.locator('#language-select').selectOption(language, { force: true });
        await page.waitForFunction((lang) => document.documentElement.lang === lang, language);
        await page.waitForFunction(
          (expected) => document.querySelector('#tab-monitor span').textContent === expected,
          dictionaries[language].monitor,
        );
        const stable = await page.evaluate(async () => {
          const { state } = await import('/state.js');
          const before = window.__I18N_SNAPSHOT__;
          return {
            connected: state.isConnected,
            recording: state.isRecording,
            columns: state.chartSeries === before.columns,
            chart: state.mainChart === before.chart,
            length: state.chartSeries.x.length === before.length,
            energy: state.energy.wh === before.energy,
            range: state.settings.rangeStart === 200 && state.settings.rangeEnd === 800,
            generation: window.__WITRN_STREAM__().generation === before.generation,
            filter: document.getElementById('pd-filter').value === 'Source',
            selected: document.querySelector('.pd-row.selected')?.dataset.index === before.selected,
            actualSelection: before.selected !== undefined,
            pdCaptureButton: document.getElementById('btn-pd-pause') === before.pdCaptureButton,
            pdCaptureIcon: document.querySelector('#btn-pd-pause i') === before.pdCaptureIcon,
            pdCaptureLabel: document.querySelector('#btn-pd-pause span') === before.pdCaptureLabel,
            pdDetail: document.getElementById('pd-detail-body').textContent === before.pdDetail,
          };
        });
        for (const [key, value] of Object.entries(stable))
          assert.equal(value, true, `${theme}/${width}/${language}: ${key}`);
        assert.equal(await page.locator('#btn-connect-label').textContent(), dictionaries[language].disconnect);
        assert.equal(await page.locator('#pd-filter').getAttribute('placeholder'), dictionaries[language].pdFilter);
        assert.equal(await page.locator('#btn-pd-pause span').textContent(), dictionaries[language].pauseRecording);
        assert.equal(
          await page.locator('#btn-pd-pause').getAttribute('aria-label'),
          dictionaries[language].pdFollowPause,
        );
        assert.equal(await page.locator('#pd-table-head .pd-col-time').textContent(), dictionaries[language].pdElapsed);
        const currentSelect = await page
          .locator('#language-select')
          .evaluate((select) => select.parentElement.querySelector('.cs-label').textContent);
        assert.equal(
          currentSelect,
          { en: 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語' }[language],
        );
        for (const view of ['settings', 'monitor', 'pd', 'trigger']) {
          await page.locator(view === 'settings' ? '#btn-settings-tab' : `#tab-${view}`).click();
          await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
          if (view === 'monitor') {
            await page.evaluate(async () => {
              const { state } = await import('/state.js');
              state.mainChart.setCursor({ left: 100, top: 100 });
            });
            await page.waitForFunction(
              (label) => document.querySelector('.chart-tooltip-row')?.textContent.startsWith(label),
              dictionaries[language].voltage,
            );
          }
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
          assert.equal(overflow, false, `${language}/${view}/${width}: viewport overflow`);
          await page.screenshot({ path: resolve(output, `${language}-${theme}-${width}-${view}.png`) });
        }
        assert.equal(await page.locator('#km-pdm-status').textContent(), dictionaries[language].pdmOpen);
        await page.locator('#btn-settings-tab').click();
      }
      console.log(
        `PASS: ${theme} ${width}x${height}, four languages, active connection/recording/PDM and preserved data/selection`,
      );
      assert.deepEqual(await page.evaluate(() => window.__SHOWCASE__.diagnostics().errors), []);
      await context.close();
    }
  assert.deepEqual(failures, []);
  console.log('PASS: native locale mapping and English fallback');
} finally {
  await browser.close();
  await server.close();
}
