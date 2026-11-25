import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function launch(profile) {
  const executablePath = process.env['NEWEDITOR_EXECUTABLE'];
  const env = { ...process.env, NEWEDITOR_USER_DATA: profile };
  delete env['ELECTRON_RUN_AS_NODE'];
  env['ELECTRON_RENDERER_URL'] = executablePath
    ? 'https://ignored-in-packaged-app.example/'
    : process.env['NEWEDITOR_TEST_DEV'] === '1'
      ? 'http://127.0.0.1:5173/'
      : '';
  return electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : [resolve('.')],
    env,
  });
}

test('React, sandbox, IPC, SQLite, навигация и один экземпляр', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'neweditor-ui-'));
  let app;
  try {
    app = await launch(profile);
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('heading', { name: 'Нет открытых документов' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('SQLite готова · схема 2');
    expect(
      await page.evaluate(async () => ({
        methods: Object.keys(window.desktop).sort(),
        node: typeof window.require,
        process: typeof window.process,
        info: await window.desktop.getAppInfo(),
        health: await window.desktop.getStorageHealth(),
      })),
    ).toEqual({
      methods: ['getAppInfo', 'getStorageHealth'],
      node: 'undefined',
      process: 'undefined',
      info: { ok: true, value: { appVersion: '0.1.0' } },
      health: { ok: true, value: { schemaVersion: 2 } },
    });
    const runtime = await app.evaluate(({ BrowserWindow, app }) => {
      const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      const fs = process.getBuiltinModule('fs'),
        path = process.getBuiltinModule('path');
      return {
        sandbox: prefs.sandbox,
        isolated: prefs.contextIsolation,
        node: prefs.nodeIntegration,
        webSecurity: prefs.webSecurity,
        packaged: app.isPackaged,
        electron: process.versions.electron,
        abi: process.versions.modules,
        privateModes:
          process.platform === 'win32'
            ? null
            : [
                app.getPath('userData'),
                ...['service.sqlite', 'service.sqlite-wal', 'service.sqlite-shm'].map((name) =>
                  path.join(app.getPath('userData'), name),
                ),
              ].map((file) => fs.statSync(file).mode & 0o777),
        appPath: app.getAppPath(),
        nativeTestsPresent: process
          .getBuiltinModule('fs')
          .existsSync(
            process.getBuiltinModule('path').join(app.getAppPath(), 'out', 'native-tests'),
          ),
        nativeModules: Object.keys(
          process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`)
            .cache,
        ).filter((path) => path.endsWith('.node')),
      };
    });
    expect(runtime).toMatchObject({
      sandbox: true,
      isolated: true,
      node: false,
      webSecurity: true,
      packaged: Boolean(process.env['NEWEDITOR_EXECUTABLE']),
    });
    console.log(runtime);
    if (runtime.privateModes) expect(runtime.privateModes).toEqual([0o700, 0o600, 0o600, 0o600]);
    if (runtime.packaged) expect(runtime.nativeTestsPresent).toBe(false);
    expect(
      runtime.nativeModules.some((path) =>
        path.startsWith(`${join(runtime.appPath, 'node_modules', 'better-sqlite3')}${sep}`),
      ),
    ).toBe(true);
    const csp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content');
    expect(csp).toContain("default-src 'none'");
    if (process.env['NEWEDITOR_TEST_DEV'] !== '1') {
      expect(csp).toContain("connect-src 'none'");
      expect(csp.split(';').find((rule) => rule.trim().startsWith('script-src'))).not.toContain(
        'unsafe-inline',
      );
    }
    const rogueReply = await app.evaluate(async ({ BrowserWindow }) => {
      const rogue = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
      });
      try {
        await rogue.loadURL('about:blank');
        return await rogue.webContents.executeJavaScript(
          "require('electron').ipcRenderer.invoke('storage:health', null)",
        );
      } finally {
        rogue.destroy();
      }
    });
    expect(rogueReply).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
    expect(await page.evaluate(() => window.open('about:blank'))).toBeNull();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    const originalUrl = page.url();
    expect(
      await app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        return new Promise((resolve) => {
          contents.once('will-navigate', (event) => resolve(event.defaultPrevented));
          void contents.executeJavaScript('location.href = "https://example.test/"');
        });
      }),
    ).toBe(true);
    expect(page.url()).toBe(originalUrl);

    await run(app.process().spawnfile, app.process().spawnargs.slice(1), {
      env: { ...process.env, NEWEDITOR_USER_DATA: profile, ELECTRON_RUN_AS_NODE: '' },
      timeout: 10_000,
    });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('ошибка служебной БД видна, существующий файл не сбрасывается', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'neweditor-ui-error-'));
  const marker = 'not a sqlite database';
  let app;
  try {
    await writeFile(join(profile, 'service.sqlite'), marker);
    app = await launch(profile);
    const page = await app.firstWindow();
    await expect(page.getByRole('alert')).toContainText('Служебная база недоступна');
    expect(await page.evaluate(() => window.desktop.getStorageHealth())).toMatchObject({
      ok: false,
      error: { code: 'io-error' },
    });
  } finally {
    await app?.close();
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(join(profile, 'service.sqlite'), 'utf8')).toBe(marker);
    await rm(profile, { recursive: true, force: true });
  }
});
