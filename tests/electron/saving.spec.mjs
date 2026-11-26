import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'neweditor-saving-')),
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
  let settings = {
    openPaths: [],
    savePaths: [],
    decision: 2,
    overwrite: false,
    mutateOnOverwrite: null,
  };
  const configure = async (changes) => {
    settings = { ...settings, ...changes };
    await app.evaluate(({ dialog }, config) => {
      const paths = [...config.savePaths];
      dialog.showOpenDialog = async () => ({
        canceled: config.openPaths.length === 0,
        filePaths: config.openPaths,
      });
      dialog.showSaveDialog = async () => {
        const filePath = paths.shift();
        return { canceled: !filePath, filePath };
      };
      dialog.showMessageBox = async (_window, options) => {
        if (options.buttons.length === 2) {
          if (config.mutateOnOverwrite)
            process
              .getBuiltinModule('fs')
              .writeFileSync(config.mutateOnOverwrite, 'external during confirmation');
          return { response: config.overwrite ? 0 : 1, checkboxChecked: false };
        }
        return { response: config.decision, checkboxChecked: false };
      };
    }, settings);
  };
  await configure({});
  const content = () => page.locator('.workspace-source-editor .cm-content');
  const append = async (text) => {
    await content().click();
    await content().press('ControlOrMeta+End');
    await page.keyboard.insertText(text);
  };
  const cleanup = async () => {
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
      })
      .catch(() => {});
    await app.close().catch(() => {});
    await rm(folder, { recursive: true, force: true });
  };
  return { folder, app, page, configure, content, append, cleanup };
}

test('P5.3: пустой новый файл, Ctrl+S, имя и повторное открытие точного снимка', async () => {
  const f = await fixture();
  try {
    const path = join(f.folder, 'Новый файл.txt');
    await f.configure({ savePaths: [path] });
    await f.page.getByRole('button', { name: 'Новый TXT', exact: true }).click();
    await f.page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(f.page.getByRole('tab', { name: 'Новый файл.txt', exact: true })).toBeVisible();
    expect(await readFile(path, 'utf8')).toBe('');
    await f.append('Привет😀');
    await f.configure({ savePaths: [] });
    await f.content().press('ControlOrMeta+s');
    await expect(f.page.getByTestId('save-state')).toHaveText('Сохранено');
    expect(await readFile(path, 'utf8')).toBe('Привет😀');
    await f.page.getByRole('button', { name: 'Закрыть Новый файл.txt', exact: true }).click();
    await expect(f.page.getByRole('tab')).toHaveCount(0);
    await f.configure({ openPaths: [path] });
    await f.page.getByRole('button', { name: 'Открыть…', exact: true }).click();
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['Привет😀']);
  } finally {
    await f.cleanup();
  }
});

test('P5.3: отмена/подтверждение Save As, точные переводы и неизменность старого файла', async () => {
  const f = await fixture();
  try {
    const source = join(f.folder, 'source.txt'),
      target = join(f.folder, 'target.txt'),
      text = 'A\r\nB\rC\n';
    await writeFile(source, text);
    await writeFile(target, 'preimage');
    await f.configure({ openPaths: [source], savePaths: [target], overwrite: false });
    await f.page.getByRole('button', { name: 'Открыть…', exact: true }).click();
    await f.append('Z');
    await f.page.getByRole('button', { name: 'Сохранить как…', exact: true }).click();
    await expect(f.page.getByRole('tab', { name: /^source.txt/ })).toContainText('●');
    expect(await readFile(target, 'utf8')).toBe('preimage');
    await f.configure({ savePaths: [target], overwrite: true });
    await f.content().press('ControlOrMeta+Shift+s');
    await expect(f.page.getByRole('tab', { name: 'target.txt', exact: true })).toBeVisible();
    expect(await readFile(target, 'utf8')).toBe(text + 'Z');
    expect(await readFile(source, 'utf8')).toBe(text);
    await f.page.getByRole('button', { name: 'Отменить', exact: true }).click();
    await expect(f.page.getByRole('tab', { name: /^target.txt/ })).toContainText('●');
  } finally {
    await f.cleanup();
  }
});

test('P5.3: изменение цели во время подтверждения не перезаписывается', async () => {
  const f = await fixture();
  try {
    const path = join(f.folder, 'target.txt');
    await writeFile(path, 'before');
    await f.configure({ savePaths: [path], overwrite: true, mutateOnOverwrite: path });
    await f.page.getByRole('button', { name: 'Новый TXT', exact: true }).click();
    await f.append('ours');
    await f.page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(f.page.getByRole('alert')).toContainText('Цель изменилась');
    expect(await readFile(path, 'utf8')).toBe('external during confirmation');
    await expect(f.page.getByRole('tab', { name: /^Без имени 1.txt/ })).toContainText('●');
  } finally {
    await f.cleanup();
  }
});

test('P5.3: CP1251/UTF-8 BOM и ошибка непредставимого текста без потери Unicode', async () => {
  const f = await fixture();
  try {
    const path = join(f.folder, 'cp.txt'),
      bytes = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 13, 10]);
    await writeFile(path, bytes);
    await f.configure({ openPaths: [path] });
    await f.page.getByRole('button', { name: 'Открыть…', exact: true }).click();
    await expect(f.page.getByLabel('Кодировка', { exact: true })).toHaveValue('windows-1251');
    await f.append('!');
    await f.page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(f.page.getByTestId('save-state')).toHaveText('Сохранено');
    expect(await readFile(path)).toEqual(Buffer.concat([bytes, Buffer.from('!')]));
    await f.page.getByLabel('Кодировка', { exact: true }).selectOption('utf-8');
    await f.page.getByLabel('UTF-8 BOM', { exact: true }).check();
    await f.page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(f.page.getByTestId('save-state')).toHaveText('Сохранено');
    expect(await readFile(path)).toEqual(
      Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from('Привет\r\n!')]),
    );
    const emoji = join(f.folder, 'emoji.txt');
    await f.configure({ savePaths: [emoji] });
    await f.page.getByRole('button', { name: 'Новый TXT', exact: true }).click();
    await f.append('😀');
    await f.page.getByLabel('Кодировка', { exact: true }).selectOption('windows-1251');
    await f.page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(f.page.getByTestId('save-state')).toContainText('нельзя точно сохранить');
    expect(existsSync(emoji)).toBe(false);
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['😀']);
    await f.configure({ savePaths: [emoji] });
    await f.page.getByLabel('Кодировка', { exact: true }).selectOption('utf-8');
    await f.page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(f.page.getByRole('tab', { name: 'emoji.txt', exact: true })).toBeVisible();
    expect(await readFile(emoji, 'utf8')).toBe('😀');
  } finally {
    await f.cleanup();
  }
});

test('P5.3: Save/Discard/Cancel вкладки и отмена выбора цели', async () => {
  const f = await fixture();
  try {
    await f.page.getByRole('button', { name: 'Новый TXT', exact: true }).click();
    await f.append('keep');
    await f.page.getByRole('button', { name: 'Закрыть Без имени 1.txt', exact: true }).click();
    await expect(f.page.getByRole('tab')).toHaveCount(1);
    await f.configure({ decision: 0, savePaths: [] });
    await f.page.getByRole('button', { name: 'Закрыть Без имени 1.txt', exact: true }).click();
    await expect(f.page.getByRole('tab')).toHaveCount(1);
    const path = join(f.folder, 'closed.txt');
    await f.configure({ decision: 0, savePaths: [path] });
    await f.page.getByRole('button', { name: 'Закрыть Без имени 1.txt', exact: true }).click();
    await expect(f.page.getByRole('tab')).toHaveCount(0);
    expect(await readFile(path, 'utf8')).toBe('keep');
    await f.page.getByRole('button', { name: 'Новый TXT', exact: true }).click();
    await f.append('discard');
    await f.configure({ decision: 1 });
    await f.page.getByRole('button', { name: 'Закрыть Без имени 2.txt', exact: true }).click();
    await expect(f.page.getByRole('tab')).toHaveCount(0);
  } finally {
    await f.cleanup();
  }
});

test('P5.3: native quit отменяется, затем сохраняет несколько вкладок через handshake', async () => {
  const f = await fixture();
  try {
    await f.page.getByRole('button', { name: 'Новый TXT', exact: true }).click();
    await f.append('one');
    await f.page.getByRole('button', { name: 'Новый TXT', exact: true }).click();
    await f.append('two');
    await f.app.evaluate(({ app }) => app.quit());
    await expect(f.page.getByRole('alert')).toContainText('Закрытие отменено');
    await expect(f.page.getByRole('tab')).toHaveCount(2);
    expect(await f.page.evaluate(() => window.desktop.getStorageHealth())).toMatchObject({
      ok: true,
    });
    const one = join(f.folder, 'one.txt'),
      two = join(f.folder, 'two.txt');
    await f.configure({ decision: 0, savePaths: [one, two] });
    await f.app.close();
    expect(await readFile(one, 'utf8')).toBe('one');
    expect(await readFile(two, 'utf8')).toBe('two');
  } finally {
    await f.cleanup();
  }
});

test('P5.3: новый ввод в диалоге не подпадает под старое разрешение discard', async () => {
  const f = await fixture();
  try {
    await f.page.getByRole('button', { name: 'Новый TXT', exact: true }).click();
    await f.append('A');
    await f.app.evaluate(({ dialog }) => {
      dialog.showMessageBox = () =>
        new Promise((resolve) => {
          dialog.showMessageBox.resolve = resolve;
        });
    });
    await f.page.getByRole('button', { name: 'Закрыть Без имени 1.txt', exact: true }).click();
    await expect
      .poll(() => f.app.evaluate(({ dialog }) => typeof dialog.showMessageBox.resolve))
      .toBe('function');
    await f.append('B');
    await f.app.evaluate(({ dialog }) =>
      dialog.showMessageBox.resolve({ response: 1, checkboxChecked: false }),
    );
    await expect(f.page.getByRole('alert')).toContainText('новые правки');
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['AB']);
    await expect(f.page.getByRole('tab')).toHaveCount(1);
  } finally {
    await f.cleanup();
  }
});

test('P5.3: beforeunload повторно проверяет одобренное закрытие без постоянного bypass', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => {
      window.addEventListener(
        'beforeunload',
        (event) => {
          event.preventDefault();
          event.returnValue = '';
        },
        { once: true },
      );
    });
    await f.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.webContents.once('will-prevent-unload', () => {
        window.setTitle('Unload prevented');
      });
      window.close();
    });
    await expect
      .poll(() =>
        f.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()),
      )
      .toBe('Unload prevented');
    expect(await f.page.evaluate(() => window.desktop.getStorageHealth())).toMatchObject({
      ok: true,
    });
    await f.page.getByRole('button', { name: 'Новый TXT', exact: true }).click();
    await f.append('new after prevented unload');
    await f.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect(f.page.getByRole('alert')).toContainText('Закрытие отменено');
    await expect(f.page.getByRole('tab')).toHaveCount(1);
    await f.configure({ decision: 1 });
    await f.app.close();
  } finally {
    await f.cleanup();
  }
});

test('P5.3: ошибка записи оставляет текст; после устранения причины save успешен', async () => {
  const f = await fixture();
  const directory = join(f.folder, 'documents');
  try {
    await mkdir(directory);
    const path = join(directory, 'readonly.txt');
    await writeFile(path, 'old');
    await f.configure({ openPaths: [path] });
    await f.page.getByRole('button', { name: 'Открыть…', exact: true }).click();
    await f.append('new');
    await chmod(directory, 0o500);
    await f.page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(f.page.getByTestId('save-state')).toContainText('Файл не записан');
    expect(await readFile(path, 'utf8')).toBe('old');
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['oldnew']);
    await chmod(directory, 0o700);
    await f.content().press('ControlOrMeta+s');
    await expect(f.page.getByTestId('save-state')).toHaveText('Сохранено');
    expect(await readFile(path, 'utf8')).toBe('oldnew');
  } finally {
    await chmod(directory, 0o700).catch(() => {});
    await f.cleanup();
  }
});

test('P5.3: history-pending отображается отдельно и reconcile не затирает внешний файл', async () => {
  const f = await fixture();
  try {
    const path = join(f.folder, 'pending.txt');
    await writeFile(path, 'old');
    await f.configure({ openPaths: [path] });
    await f.page.getByRole('button', { name: 'Открыть…', exact: true }).click();
    await f.append('ours');
    const trigger = async (create) =>
      f.app.evaluate(({ app }, create) => {
        const require = process
            .getBuiltinModule('module')
            .createRequire(`${app.getAppPath()}/package.json`),
          Database = require('better-sqlite3');
        const db = new Database(
          process.getBuiltinModule('path').join(app.getPath('userData'), 'service.sqlite'),
        );
        try {
          db.exec(
            create
              ? "CREATE TRIGGER fail_gui_history BEFORE INSERT ON saved_versions BEGIN SELECT RAISE(ABORT, 'test'); END;"
              : 'DROP TRIGGER fail_gui_history',
          );
        } finally {
          db.close();
        }
      }, create);
    await trigger(true);
    await f.page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(f.page.getByTestId('save-state')).toContainText('история ожидает');
    expect(await readFile(path, 'utf8')).toBe('oldours');
    await writeFile(path, 'external');
    await trigger(false);
    await f.page.getByRole('button', { name: 'Проверить сохранение', exact: true }).click();
    await expect(f.page.getByTestId('save-state')).toHaveText('Сохранено');
    expect(await readFile(path, 'utf8')).toBe('external');
  } finally {
    await f.cleanup();
  }
});
