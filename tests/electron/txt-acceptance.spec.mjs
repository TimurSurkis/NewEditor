import { test, expect, _electron as electron } from '@playwright/test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'neweditor-txt-acceptance-'));
  const documents = join(folder, 'Мои документы');
  await mkdir(documents);
  const launch = async () => {
    const executablePath = process.env.NEWEDITOR_EXECUTABLE;
    const env = {
      ...process.env,
      NEWEDITOR_USER_DATA: join(folder, 'profile'),
      ELECTRON_RENDERER_URL: process.env.NEWEDITOR_TEST_DEV === '1' ? 'http://127.0.0.1:5173/' : '',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({
      ...(executablePath ? { executablePath } : {}),
      args: executablePath ? [] : [resolve('.')],
      env,
    });
    const page = await app.firstWindow();
    await expect(page.getByRole('status')).toContainText('SQLite готова');
    return { app, page };
  };
  let session = await launch();
  const configure = async ({ paths = [], savePath = null, close = 2, overwrite = false } = {}) =>
    session.app.evaluate(
      ({ dialog }, input) => {
        dialog.showOpenDialog = async () => ({
          canceled: input.paths.length === 0,
          filePaths: input.paths,
        });
        dialog.showSaveDialog = async () => ({
          canceled: !input.savePath,
          filePath: input.savePath,
        });
        dialog.showMessageBox = async (_window, options) => ({
          response: options.buttons.length === 2 ? (input.overwrite ? 0 : 1) : input.close,
          checkboxChecked: false,
        });
      },
      { paths, savePath, close, overwrite },
    );
  await configure();
  return {
    folder,
    documents,
    get page() {
      return session.page;
    },
    async open(paths) {
      await configure({ paths });
      await session.page.getByRole('button', { name: 'Открыть…', exact: true }).click();
      await expect(session.page.getByRole('tab')).toHaveCount(paths.length);
    },
    configure,
    async append(text) {
      const content = session.page.locator('.workspace-source-editor .cm-content');
      await content.click();
      await content.press('ControlOrMeta+End');
      await session.page.keyboard.insertText(text);
    },
    async save() {
      await session.page.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await expect(session.page.getByTestId('save-state')).toHaveText('Сохранено');
    },
    async closeTabs() {
      let count = await session.page.getByRole('tab').count();
      while (count > 0) {
        await session.page
          .getByRole('button', { name: /^Закрыть / })
          .first()
          .click();
        await expect(session.page.getByRole('tab')).toHaveCount(--count);
      }
    },
    async restart() {
      await session.app.close();
      session = await launch();
      await configure();
      await expect(session.page.getByRole('tab')).toHaveCount(0);
    },
    async cleanup() {
      await session.app
        .evaluate(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) window.destroy();
        })
        .catch(() => {});
      await session.app.close().catch(() => {});
      await rm(folder, { recursive: true, force: true });
    },
  };
}

const lines = (text) => text.split(/\r\n|\r|\n/);

test('P5.5 TXT-01/02: несколько кодировок → правки/поиск/undo → save → закрытие → перезапуск и открытие', async () => {
  const f = await fixture();
  try {
    const cp = Buffer.concat([
      Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
      Buffer.from('\r\nA\rB\n'),
    ]);
    const cases = [
      {
        name: 'Юникод 😀.txt',
        text: 'Привет😀 e\u0308\r\none\rtwo\n',
        encoding: 'utf-8',
        bom: false,
        suffix: ' utf8',
      },
      { name: 'С BOM.txt', text: 'База\r\nBOM\r', encoding: 'utf-8', bom: true, suffix: ' bom' },
      {
        name: 'Кириллица 1251.txt',
        text: 'Привет\r\nA\rB\n',
        encoding: 'windows-1251',
        bom: false,
        suffix: ' cp',
      },
    ].map((item) => ({
      ...item,
      path: join(f.documents, item.name),
      before:
        item.encoding === 'windows-1251'
          ? cp
          : Buffer.concat([
              item.bom ? Buffer.from([239, 187, 191]) : Buffer.alloc(0),
              Buffer.from(item.text),
            ]),
    }));
    for (const item of cases) await writeFile(item.path, item.before);
    await f.open(cases.map((item) => item.path));
    for (const [index, item] of cases.entries()) {
      await f.page.getByRole('tab').nth(index).click();
      await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(
        lines(item.text),
      );
      await expect(f.page.getByLabel('Кодировка', { exact: true })).toHaveValue(item.encoding);
      expect(await f.page.getByLabel('UTF-8 BOM', { exact: true }).isChecked()).toBe(item.bom);
      if (index === 0) {
        await f.page.getByRole('button', { name: 'Поиск и замена', exact: true }).click();
        await f.page.getByRole('textbox', { name: 'Найти', exact: true }).fill('one');
        await f.page.getByRole('textbox', { name: 'Заменить на', exact: true }).fill('ONE');
        await f.page.getByRole('button', { name: 'Заменить всё', exact: true }).click();
        await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(
          lines(item.text.replace('one', 'ONE')),
        );
        await f.page.getByRole('button', { name: 'Отменить', exact: true }).click();
        await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(
          lines(item.text),
        );
        await f.page.getByRole('button', { name: 'Повторить', exact: true }).click();
        await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(
          lines(item.text.replace('one', 'ONE')),
        );
        await f.page.getByRole('button', { name: 'Поиск и замена', exact: true }).click();
      }
      await f.append(item.suffix);
      await expect(f.page.getByRole('tab').nth(index)).toContainText('●');
      for (const untouched of cases)
        expect(await readFile(untouched.path)).toEqual(untouched.before);
    }
    const after = cases.map((item, index) =>
      item.encoding === 'windows-1251'
        ? Buffer.concat([item.before, Buffer.from(item.suffix)])
        : Buffer.concat([
            item.bom ? Buffer.from([239, 187, 191]) : Buffer.alloc(0),
            Buffer.from((index === 0 ? item.text.replace('one', 'ONE') : item.text) + item.suffix),
          ]),
    );
    for (const [index, item] of cases.entries()) {
      await f.page.getByRole('tab').nth(index).click();
      await f.save();
      await expect(f.page.getByRole('tab').nth(index)).toHaveText(item.name);
      for (const [other, entry] of cases.entries())
        expect(await readFile(entry.path)).toEqual(other <= index ? after[other] : entry.before);
    }
    await f.closeTabs();
    await f.restart();
    await f.open(cases.map((item) => item.path));
    for (const [index, item] of cases.entries()) {
      await f.page.getByRole('tab').nth(index).click();
      await expect(f.page.getByRole('tab').nth(index)).toHaveText(item.name);
      await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(
        lines((index === 0 ? item.text.replace('one', 'ONE') : item.text) + item.suffix),
      );
      await expect(f.page.getByLabel('Кодировка', { exact: true })).toHaveValue(item.encoding);
      expect(await f.page.getByLabel('UTF-8 BOM', { exact: true }).isChecked()).toBe(item.bom);
      await expect(f.page.getByRole('button', { name: 'Отменить', exact: true })).toBeDisabled();
      expect(await readFile(item.path)).toEqual(after[index]);
    }
    await f.closeTabs();
  } finally {
    await f.cleanup();
  }
});

test('P5.5 TXT-03: ошибка Save при закрытии не теряет вкладку и не мешает сохранить другой TXT', async () => {
  const f = await fixture();
  const locked = join(f.documents, 'locked');
  try {
    await mkdir(locked);
    const first = join(locked, 'Ошибка записи.txt'),
      second = join(f.documents, 'Другая вкладка.txt');
    await writeFile(first, 'first\r\n');
    await writeFile(second, 'second\r');
    await f.open([first, second]);
    await f.page.getByRole('tab').nth(0).click();
    await f.append('ours');
    await f.configure({ close: 0 });
    await chmod(locked, 0o500);
    await f.page.getByRole('button', { name: `Закрыть ${basename(first)}`, exact: true }).click();
    await expect(f.page.getByTestId('save-state')).toContainText('Файл не записан');
    await expect(f.page.getByRole('tab')).toHaveCount(2);
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['first', 'ours']);
    expect(await readFile(first, 'utf8')).toBe('first\r\n');
    await f.page.getByRole('tab').nth(1).click();
    await f.append('ok');
    await f.save();
    await f.page.getByRole('button', { name: `Закрыть ${basename(second)}`, exact: true }).click();
    await expect(f.page.getByRole('tab')).toHaveCount(1);
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['first', 'ours']);
    await chmod(locked, 0o700);
    await f.page.getByRole('button', { name: `Закрыть ${basename(first)}`, exact: true }).click();
    await expect(f.page.getByRole('tab')).toHaveCount(0);
    expect(await readFile(first, 'utf8')).toBe('first\r\nours');
    expect(await readFile(second, 'utf8')).toBe('second\rok');
    await f.open([first, second]);
    for (const [index, text] of ['first\r\nours', 'second\rok'].entries()) {
      await f.page.getByRole('tab').nth(index).click();
      await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(lines(text));
      await expect(f.page.getByTestId('save-state')).toHaveText('Сохранено');
    }
    await f.closeTabs();
  } finally {
    await chmod(locked, 0o700).catch(() => {});
    await f.cleanup();
  }
});

test('P5.5 TXT-04: одинаковые имена независимы; Save As в занятую цель не меняет файлы', async () => {
  const f = await fixture();
  try {
    const directories = [join(f.documents, 'один'), join(f.documents, 'два')];
    for (const directory of directories) await mkdir(directory);
    const paths = directories.map((directory) => join(directory, 'текст.txt')),
      copy = join(f.documents, 'копия.txt');
    await writeFile(paths[0], 'alpha');
    await writeFile(paths[1], 'beta');
    await f.open(paths);
    await f.page.getByRole('tab').nth(0).click();
    await f.append('!');
    await f.page.getByRole('tab').nth(1).click();
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['beta']);
    await f.page.getByRole('tab').nth(0).click();
    await f.configure({ savePath: paths[1], overwrite: true });
    await f.page.getByRole('button', { name: 'Сохранить как…', exact: true }).click();
    await expect(f.page.getByRole('alert').first()).toContainText('Операция требует завершения');
    await expect(f.page.getByRole('tab').nth(0)).toHaveText('текст.txt ●');
    await expect(f.page.getByRole('tab').nth(1)).toHaveText('текст.txt');
    expect(await readFile(paths[0], 'utf8')).toBe('alpha');
    expect(await readFile(paths[1], 'utf8')).toBe('beta');
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['alpha!']);
    await f.configure({ savePath: copy });
    await f.page.getByRole('button', { name: 'Сохранить как…', exact: true }).click();
    await expect(f.page.getByRole('tab').nth(0)).toHaveText('копия.txt');
    await f.closeTabs();
    await f.open([...paths, copy]);
    for (const [index, text] of ['alpha', 'beta', 'alpha!'].entries()) {
      await f.page.getByRole('tab').nth(index).click();
      await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText([text]);
      expect(await readFile([...paths, copy][index], 'utf8')).toBe(text);
    }
    await f.closeTabs();
  } finally {
    await f.cleanup();
  }
});
