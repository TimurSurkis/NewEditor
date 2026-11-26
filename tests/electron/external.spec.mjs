import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'neweditor-external-')),
    executablePath = process.env.NEWEDITOR_EXECUTABLE;
  const env = {
    ...process.env,
    NEWEDITOR_USER_DATA: folder,
    ELECTRON_RENDERER_URL: process.env.NEWEDITOR_TEST_DEV === '1' ? 'http://127.0.0.1:5173/' : '',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
      ...(executablePath ? { executablePath } : {}),
      args: executablePath ? [] : [resolve('.')],
      env,
    }),
    page = await app.firstWindow();
  await expect(page.getByRole('status')).toContainText('SQLite готова');
  const path = join(folder, 'document.txt');
  await writeFile(path, 'old');
  const choose = async (savePath = null, decision = 2) =>
    app.evaluate(
      ({ dialog }, config) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [config.path] });
        dialog.showSaveDialog = async () => ({
          canceled: !config.savePath,
          filePath: config.savePath,
        });
        dialog.showMessageBox = async () => ({ response: config.decision, checkboxChecked: false });
      },
      { path, savePath, decision },
    );
  await choose();
  await page.getByRole('button', { name: 'Открыть…', exact: true }).click();
  await expect(page.locator('.workspace-source-editor .cm-line')).toHaveText(['old']);
  const append = async (text) => {
    const content = page.locator('.workspace-source-editor .cm-content');
    await content.click();
    await content.press('ControlOrMeta+End');
    await page.keyboard.insertText(text);
  };
  const check = () =>
    page.getByRole('button', { name: 'Проверить изменения', exact: true }).click();
  const cleanup = async () => {
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
      })
      .catch(() => {});
    await app.close().catch(() => {});
    await rm(folder, { recursive: true, force: true });
  };
  return { folder, path, app, page, choose, append, check, cleanup };
}

test('P5.4: атомарная внешняя замена чистого файла обновляет DOM/кодировку, собственный save не конфликтует', async () => {
  const f = await fixture();
  try {
    const temp = join(f.folder, 'replacement.txt');
    await writeFile(temp, Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]));
    await rename(temp, f.path);
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['Привет']);
    await expect(f.page.getByLabel('Кодировка', { exact: true })).toHaveValue('windows-1251');
    await expect(f.page.getByRole('tab', { name: 'document.txt', exact: true })).toBeVisible();
    await f.append('!');
    await f.page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(f.page.getByTestId('save-state')).toHaveText('Сохранено');
    await f.check();
    await expect(f.page.getByRole('region', { name: 'Внешние изменения' })).toHaveCount(0);
    expect(await readFile(f.path)).toEqual(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 33]));
  } finally {
    await f.cleanup();
  }
});

test('P5.4: dirty-сравнение не исполняет HTML и Save As сохраняет рабочую копию отдельно', async () => {
  const f = await fixture();
  try {
    await f.append('ours');
    const external = '<img src=x onerror="globalThis.externalExecuted=true">\r\nexternal';
    await writeFile(f.path, external);
    await expect(f.page.getByLabel('Внешний файл', { exact: true })).toHaveText(external);
    await expect(f.page.getByLabel('Рабочая копия', { exact: true })).toHaveText('oldours');
    expect(await f.page.evaluate(() => globalThis.externalExecuted)).toBeUndefined();
    expect(await f.page.locator('.workspace-conflict img').count()).toBe(0);
    const copy = join(f.folder, 'copy.txt');
    await f.choose(copy);
    await f.page.getByRole('button', { name: 'Сохранить копию…', exact: true }).click();
    await expect(f.page.getByRole('tab', { name: 'copy.txt', exact: true })).toBeVisible();
    expect(await readFile(copy, 'utf8')).toBe('oldours');
    expect(await readFile(f.path, 'utf8')).toBe(external);
    await writeFile(f.path, 'old location changed again');
    await f.check();
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['oldours']);
    await expect(f.page.getByRole('region', { name: 'Внешние изменения' })).toHaveCount(0);
  } finally {
    await f.cleanup();
  }
});

test('P5.4: загрузка внешнего снимка требует явного действия и очищает undo', async () => {
  const f = await fixture();
  try {
    await f.append('ours');
    await writeFile(f.path, 'theirs');
    await f.check();
    await expect(f.page.getByLabel('Внешний файл', { exact: true })).toHaveText('theirs');
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['oldours']);
    await f.page
      .getByRole('button', { name: 'Загрузить файл вместо рабочей копии', exact: true })
      .click();
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['theirs']);
    await expect(f.page.getByTestId('save-state')).toHaveText('Сохранено');
    await expect(f.page.getByRole('button', { name: 'Отменить', exact: true })).toBeDisabled();
  } finally {
    await f.cleanup();
  }
});

test('P5.4: удаление чистого файла сохраняет текст, блокирует reload и спрашивает Save As при закрытии', async () => {
  const f = await fixture();
  try {
    await rm(f.path);
    await expect(f.page.getByRole('heading', { name: /Файл удалён/ })).toBeVisible();
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['old']);
    await f.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.reload(),
    );
    await expect(f.page.getByRole('alert').last()).toContainText('Перезагрузка отменена');
    await f.page.getByRole('button', { name: 'Закрыть document.txt', exact: true }).click();
    await expect(f.page.getByRole('tab')).toHaveCount(1);
    const copy = join(f.folder, 'rescued.txt');
    await f.choose(copy, 0);
    await f.page.getByRole('button', { name: 'Закрыть document.txt', exact: true }).click();
    await expect(f.page.getByRole('tab')).toHaveCount(0);
    expect(await readFile(copy, 'utf8')).toBe('old');
  } finally {
    await f.cleanup();
  }
});

test('P5.4: повторное появление файла и focus-refresh обновляют чистую рабочую копию', async () => {
  const f = await fixture();
  try {
    await rm(f.path);
    await expect(f.page.getByRole('heading', { name: /Файл удалён/ })).toBeVisible();
    await writeFile(f.path, 'recreated');
    await f.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('focus'));
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['recreated']);
    await expect(f.page.getByRole('region', { name: 'Внешние изменения' })).toHaveCount(0);
  } finally {
    await f.cleanup();
  }
});

test('P5.4: IME не заменяется внешним чтением, после flush доступно сравнение', async () => {
  const f = await fixture();
  try {
    const content = f.page.locator('.workspace-source-editor .cm-content');
    await content.click();
    await content.press('ControlOrMeta+End');
    const cdp = await f.app.context().newCDPSession(f.page);
    await cdp.send('Input.imeSetComposition', {
      text: '日本語',
      selectionStart: 3,
      selectionEnd: 3,
    });
    await writeFile(f.path, 'external');
    expect(await f.page.evaluate(() => window.desktop.refreshResources())).toMatchObject({
      ok: true,
    });
    await cdp.send('Input.insertText', { text: '日本語' });
    await expect(f.page.getByLabel('Внешний файл', { exact: true })).toHaveText('external');
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['old日本語']);
  } finally {
    await f.cleanup();
  }
});

test('P5.4: неподдерживаемый внешний файл не затирает текст; повтор чтения и watch IPC ограничены', async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, Buffer.from([255, 254, 65, 0]));
    await f.check();
    await expect(f.page.getByRole('alert').last()).toContainText('UTF-16');
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['old']);
    await expect(
      f.page.getByRole('button', { name: 'Загрузить файл вместо рабочей копии', exact: true }),
    ).toHaveCount(0);
    const denied = await f.page.evaluate(
      () =>
        new Promise((resolve) => {
          const stop = window.desktop.watchResource(
            { storageId: 'local', resourceId: 'unknown' },
            () => resolve('unexpected event'),
            (error) => {
              stop();
              resolve(error.code);
            },
          );
        }),
    );
    expect(denied).toBe('permission-denied');
    await writeFile(f.path, 'valid again');
    await f.check();
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['valid again']);
    await expect(f.page.getByRole('region', { name: 'Внешние изменения' })).toHaveCount(0);
  } finally {
    await f.cleanup();
  }
});
