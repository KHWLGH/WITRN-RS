// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** @param {string} file */
const read = (file) => readFileSync(path.join(root, file), 'utf8');

test('the macOS Settings… menu item opens the settings view through one event name', () => {
  const menu = read('src-tauri/src/app_menu.rs');
  const event = menu.match(/const OPEN_SETTINGS: &str = "([^"]+)";/)?.[1];
  assert.ok(event, 'app_menu.rs names the menu event');
  assert.match(
    menu,
    /MenuItem::with_id\(\s*app,\s*OPEN_SETTINGS,\s*"Settings…",\s*true,\s*Some\("CmdOrCtrl\+,"\),?\s*\)/,
    'Settings… keeps the standard ⌘, shortcut',
  );
  assert.match(
    read('src/app.js'),
    new RegExp(`listen\\('${event}', \\(\\) => showView\\('settings'\\)\\)`),
    'the frontend listens for the same event and opens the settings view',
  );
});

test('only macOS replaces the default menu', () => {
  assert.match(
    read('src-tauri/src/lib.rs'),
    /#\[cfg\(target_os = "macos"\)\]\s*\{\s*builder = builder\s*\.menu\(app_menu::build\)\s*\.on_menu_event\(app_menu::handle\);\s*\}/,
  );
  assert.match(read('src-tauri/src/lib.rs'), /#\[cfg\(target_os = "macos"\)\]\s*mod app_menu;/);
});
