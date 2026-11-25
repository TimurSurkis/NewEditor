import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Buffer } from 'node:buffer';

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'neweditor-workspace-'));
  const executablePath = process.env['NEWEDITOR_EXECUTABLE'];
  const env = {
    ...process.env,
    NEWEDITOR_USER_DATA: folder,
    ELECTRON_RENDERER_URL:
      process.env['NEWEDITOR_TEST_DEV'] === '1' ? 'http://127.0.0.1:5173/' : '',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : [resolve('.')],
    env,
  });
  const page = await app.firstWindow();
  await expect(page.getByRole('status')).toContainText('SQLite готова');
  const choose = (paths) =>
    app.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({ canceled: paths === null, filePaths: paths ?? [] });
    }, paths);
  const close = async () => {
    await app.close();
    await rm(folder, { recursive: true, force: true });
  };
  const forceClose = async () => {
    // Только teardown собственных тестовых профилей, не production-команда discard.
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
      })
      .catch(() => {});
    await app.close().catch(() => {});
    await rm(folder, { recursive: true, force: true });
  };
  return { folder, app, page, choose, close, forceClose };
}

test('P5.1: новые TXT/MD, переключение/закрытие вкладок и отдельный прототип', async () => {
  const f = await fixture();
  try {
    await f.page.getByRole('button', { name: 'Новый TXT', exact: true }).click();
    await f.page.getByRole('button', { name: 'Новый Markdown', exact: true }).click();
    await f.page.getByRole('button', { name: 'Новый TXT', exact: true }).click();
    await expect(f.page.getByRole('tab')).toHaveCount(3);
    await f.page.getByRole('tab', { name: 'Без имени 2.md' }).click();
    await expect(f.page.getByRole('tabpanel')).toContainText('Markdown');
    await f.page.getByRole('button', { name: 'Закрыть Без имени 1.txt', exact: true }).click();
    await expect(f.page.getByRole('tab', { selected: true })).toHaveText('Без имени 2.md');
    await f.page.getByRole('button', { name: 'Закрыть Без имени 2.md', exact: true }).click();
    await expect(f.page.getByRole('tab', { selected: true })).toHaveText('Без имени 3.txt');
    await f.page.getByRole('button', { name: 'Прототип Markdown', exact: true }).click();
    await expect(f.page.getByRole('heading', { name: 'Прототип Markdown' })).toBeVisible();
    await f.page.getByRole('button', { name: 'Документы', exact: true }).click();
    await expect(f.page.getByRole('tab')).toHaveCount(1);
    await f.page.getByRole('button', { name: 'Закрыть Без имени 3.txt', exact: true }).click();
    await expect(f.page.getByRole('heading', { name: 'Нет открытых документов' })).toBeVisible();
    await f.page.getByRole('button', { name: 'Новый TXT', exact: true }).click();
    await expect(f.page.getByRole('tab', { selected: true })).toHaveText('Без имени 4.txt');
  } finally {
    await f.close();
  }
});

test('P5.1: настоящий IPC открывает UTF-8/CP1251/Markdown без изменения байтов и дубликатов', async () => {
  const f = await fixture();
  try {
    const paths = [
      join(f.folder, 'Точный текст.txt'),
      join(f.folder, 'Кодировка.txt'),
      join(f.folder, 'HTML.md'),
    ];
    const texts = [
      'A😀\r\nе\u0308\rlast\n',
      'Привет\r\n',
      '<script>window.fileExecuted = true</script>\r\n<img src="https://example.invalid/a">',
    ];
    const bytes = [
      Buffer.from(texts[0]),
      Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 13, 10]),
      Buffer.from(texts[2]),
    ];
    for (let i = 0; i < paths.length; i++) await writeFile(paths[i], bytes[i]);
    await f.choose(paths);
    await f.page.getByRole('button', { name: 'Открыть…', exact: true }).click();
    await expect(f.page.getByRole('tab')).toHaveCount(3);
    for (const [i, name] of ['Точный текст.txt', 'Кодировка.txt', 'HTML.md'].entries()) {
      await f.page.getByRole('tab', { name, exact: true }).click();
      expect(await f.page.locator('.workspace-source-editor .cm-line').allTextContents()).toEqual(
        texts[i].split(/\r\n|\r|\n/),
      );
      expect(await readFile(paths[i])).toEqual(bytes[i]);
    }
    expect(await f.page.evaluate(() => window.fileExecuted)).toBeUndefined();
    await f.choose([paths[0]]);
    await f.page.getByRole('button', { name: 'Открыть…', exact: true }).click();
    await expect(f.page.getByRole('tab', { selected: true })).toHaveText('Точный текст.txt');
    await expect(f.page.getByRole('tab')).toHaveCount(3);
    await f.page.getByRole('tab', { selected: true }).press('ArrowRight');
    await expect(f.page.getByRole('tab', { selected: true })).toHaveText('Кодировка.txt');
  } finally {
    await f.close();
  }
});

test('P5.1: отмена и частичный отказ не создают пустых вкладок и не стирают успешные', async () => {
  const f = await fixture();
  try {
    await f.choose(null);
    await f.page.getByRole('button', { name: 'Открыть…', exact: true }).click();
    await expect(f.page.getByRole('button', { name: 'Открыть…', exact: true })).toBeEnabled();
    await expect(f.page.getByRole('tab')).toHaveCount(0);
    const good = join(f.folder, 'good.txt'),
      bad = join(f.folder, 'bad.exe'),
      broken = join(f.folder, 'broken.txt');
    await writeFile(good, 'good');
    await writeFile(bad, 'bad');
    await writeFile(broken, Buffer.from([0, 1]));
    await f.choose([bad, good, broken]);
    await f.page.getByRole('button', { name: 'Открыть…', exact: true }).click();
    await expect(f.page.getByRole('tab')).toHaveCount(1);
    await expect(f.page.getByRole('alert')).toContainText('bad.exe');
    await expect(f.page.getByRole('alert')).toContainText('broken.txt');
    await f.page.getByRole('button', { name: 'Скрыть ошибки' }).click();
    await expect(f.page.getByRole('alert')).toHaveCount(0);
    await expect(f.page.getByRole('tab', { selected: true })).toHaveText('good.txt');
  } finally {
    await f.close();
  }
});

test('P5.1: runtime IPC отклоняет чужой ref/окно/лишние поля и отзывает ref при reload', async () => {
  const f = await fixture();
  try {
    const path = join(f.folder, 'granted.txt');
    await writeFile(path, 'private');
    await f.choose([path]);
    const selected = await f.page.evaluate(() => window.desktop.pickOpen());
    expect(selected.ok).toBe(true);
    const ref = selected.value.documents[0].ref;
    expect(await f.page.evaluate((ref) => window.desktop.loadDocument(ref), ref)).toMatchObject({
      ok: true,
      value: { snapshot: { text: 'private' } },
    });
    expect(
      await f.page.evaluate(() =>
        window.desktop.loadDocument({ storageId: 'local', resourceId: 'unknown' }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
    const malformed = await f.app.evaluate(
      async ({ BrowserWindow }, input) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        return contents.executeJavaScript(`window.desktop.loadDocument(${JSON.stringify(input)})`);
      },
      { ...ref, path },
    );
    expect(malformed).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    const rogue = await f.app.evaluate(async ({ BrowserWindow }, ref) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
      });
      try {
        await window.loadURL('about:blank');
        return await window.webContents.executeJavaScript(
          `require('electron').ipcRenderer.invoke('document:load', {ref:${JSON.stringify(ref)}})`,
        );
      } finally {
        window.destroy();
      }
    }, ref);
    expect(rogue).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
    await f.page.reload();
    await expect(f.page.getByRole('status')).toContainText('SQLite готова');
    expect(await f.page.evaluate((ref) => window.desktop.loadDocument(ref), ref)).toMatchObject({
      ok: false,
      error: { code: 'permission-denied' },
    });
  } finally {
    await f.close();
  }
});

test('P5.1: штатный выход дожидается незавершённого диалога после отзыва клиента', async () => {
  const f = await fixture();
  let closed = false;
  try {
    const path = join(f.folder, 'late.txt'),
      marker = join(f.folder, 'dialog-resolved');
    await writeFile(path, 'late');
    await f.app.evaluate(
      ({ app, dialog }, { path, marker }) => {
        dialog.showOpenDialog = () =>
          new Promise((resolve) => {
            app.once('before-quit', () =>
              process.getBuiltinModule('timers').setImmediate(() => {
                process.getBuiltinModule('fs').writeFileSync(marker, 'resolved');
                resolve({ canceled: false, filePaths: [path] });
              }),
            );
          });
      },
      { path, marker },
    );
    await f.page.getByRole('button', { name: 'Открыть…', exact: true }).click();
    await expect(f.page.getByRole('button', { name: 'Открытие…', exact: true })).toBeDisabled();
    await f.app.close();
    closed = true;
    expect(await readFile(marker, 'utf8')).toBe('resolved');
    expect(await readFile(path, 'utf8')).toBe('late');
  } finally {
    if (!closed) await f.app.close();
    await rm(f.folder, { recursive: true, force: true });
  }
});

test('P5.2: ввод, выделение, undo/redo двух вкладок и неизменность исходного файла', async () => {
  const f = await fixture();
  try {
    const path = join(f.folder, 'mixed.txt'),
      original = 'A😀\r\nе\u0308\rlast\n';
    await writeFile(path, original);
    await f.choose([path]);
    await f.page.getByRole('button', { name: 'Открыть…', exact: true }).click();
    const content = () => f.page.locator('.workspace-source-editor .cm-content');
    await content().click();
    await content().press('ControlOrMeta+End');
    await f.page.keyboard.insertText('X');
    await expect(f.page.getByRole('tab', { name: /^mixed.txt/ })).toContainText('●');
    await content().press('ControlOrMeta+z');
    await expect(f.page.getByRole('tab', { name: 'mixed.txt', exact: true })).toBeVisible();
    await f.page.getByRole('button', { name: 'Повторить', exact: true }).click();
    await content().press('ControlOrMeta+Home');
    await content().press('ArrowRight');
    const caret = () =>
      content().evaluate((element) => {
        const selection = window.getSelection();
        if (!selection?.anchorNode || !element.contains(selection.anchorNode)) return -1;
        const range = document.createRange();
        range.selectNodeContents(element);
        range.setEnd(selection.anchorNode, selection.anchorOffset);
        return range.toString().length;
      });
    await expect.poll(caret).toBe(1);
    await f.page.getByRole('button', { name: 'Новый TXT', exact: true }).click();
    await content().click();
    await f.page.keyboard.insertText('second');
    await f.page.getByRole('tab', { name: /^mixed.txt/ }).click();
    await content().focus();
    await expect.poll(caret).toBe(1);
    await f.page.keyboard.insertText('!');
    await expect(f.page.locator('.workspace-source-editor .cm-line').first()).toHaveText('A!😀');
    await f.page.getByRole('button', { name: 'Отменить', exact: true }).click();
    await expect(f.page.locator('.workspace-source-editor .cm-line').first()).toHaveText('A😀');
    await f.page.getByRole('tab', { name: /^Без имени 1.txt/ }).click();
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['second']);
    await f.page.getByRole('button', { name: 'Отменить', exact: true }).click();
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['']);
    expect(await readFile(path, 'utf8')).toBe(original);
  } finally {
    await f.forceClose();
  }
});

test('P5.2: буквальный поиск, регистр, многострочная замена и единая отмена', async () => {
  const f = await fixture();
  try {
    const path = join(f.folder, 'search.txt'),
      original = 'A a😀\r\nA a😀\rEND';
    await writeFile(path, original);
    await f.choose([path]);
    await f.page.getByRole('button', { name: 'Открыть…', exact: true }).click();
    const content = f.page.locator('.workspace-source-editor .cm-content');
    await f.page.getByRole('tab', { selected: true }).focus();
    await f.page.getByRole('tab', { selected: true }).press('ControlOrMeta+f');
    await f.page.getByLabel('Найти', { exact: true }).fill('a');
    await expect(f.page.getByLabel('Совпадения')).toHaveText('0 / 4');
    await f.page.getByLabel('Учитывать регистр', { exact: true }).check();
    await expect(f.page.getByLabel('Совпадения')).toHaveText('0 / 2');
    await f.page.getByLabel('Заменить на', { exact: true }).fill('$1');
    await f.page.getByRole('button', { name: 'Заменить всё', exact: true }).click();
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText([
      'A $1😀',
      'A $1😀',
      'END',
    ]);
    await f.page.getByRole('button', { name: 'Отменить', exact: true }).click();
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText([
      'A a😀',
      'A a😀',
      'END',
    ]);
    await f.page.getByLabel('Учитывать регистр', { exact: true }).uncheck();
    await f.page.getByLabel('Найти', { exact: true }).fill('a😀\nA');
    await f.page.getByLabel('Заменить на', { exact: true }).fill('X\nY');
    await f.page.getByRole('button', { name: 'Заменить всё', exact: true }).click();
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText([
      'A X',
      'Y a😀',
      'END',
    ]);
    await content.press('ControlOrMeta+z');
    await expect(f.page.getByRole('tab', { name: 'search.txt', exact: true })).toBeVisible();
    expect(await readFile(path, 'utf8')).toBe(original);
  } finally {
    await f.forceClose();
  }
});

test('P5.2: IME flush перед переключением, созданием вкладки и переходом к прототипу', async () => {
  const f = await fixture();
  try {
    await f.page.getByRole('button', { name: 'Новый TXT', exact: true }).click();
    await f.page.getByRole('button', { name: 'Новый TXT', exact: true }).click();
    await f.page.getByRole('tab', { name: 'Без имени 1.txt', exact: true }).click();
    const cdp = await f.app.context().newCDPSession(f.page),
      content = () => f.page.locator('.workspace-source-editor .cm-content');
    await content().click();
    await cdp.send('Input.imeSetComposition', {
      text: '日本語',
      selectionStart: 3,
      selectionEnd: 3,
    });
    await f.page.evaluate(() => document.querySelectorAll('[role="tab"]')[1].click());
    await expect(f.page.getByRole('tab', { selected: true })).toHaveText('Без имени 1.txt');
    await cdp.send('Input.insertText', { text: '日本語' });
    await expect(f.page.getByRole('tab', { selected: true })).toHaveText('Без имени 2.txt');
    await f.page.getByRole('tab', { name: /^Без имени 1.txt/ }).click();
    await content().focus();
    await content().press('ControlOrMeta+End');
    await cdp.send('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 });
    await f.page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent === 'Новый TXT')
        .click(),
    );
    await expect(f.page.getByRole('tab')).toHaveCount(2);
    await cdp.send('Input.insertText', { text: '中' });
    await expect(f.page.getByRole('tab')).toHaveCount(3);
    await f.page.getByRole('tab', { name: /^Без имени 1.txt/ }).click();
    await content().focus();
    await content().press('ControlOrMeta+End');
    await cdp.send('Input.imeSetComposition', { text: '本', selectionStart: 1, selectionEnd: 1 });
    await f.page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent === 'Прототип Markdown')
        .click(),
    );
    await expect(
      f.page.getByRole('heading', { name: 'Прототип Markdown', exact: true }),
    ).toHaveCount(0);
    await cdp.send('Input.insertText', { text: '本' });
    await expect(
      f.page.getByRole('heading', { name: 'Прототип Markdown', exact: true }),
    ).toBeVisible();
    await f.page.getByRole('button', { name: 'Документы', exact: true }).click();
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['日本語中本']);
  } finally {
    await f.forceClose();
  }
});

test('P5.2: dirty-ввод блокирует close/quit/reload без закрытия SQLite или отзыва ref', async () => {
  const f = await fixture();
  try {
    const path = join(f.folder, 'guard.txt');
    await writeFile(path, 'initial');
    await f.choose([path]);
    const chosen = await f.page.evaluate(() => window.desktop.pickOpen()),
      ref = chosen.value.documents[0].ref;
    await f.page.getByRole('button', { name: 'Открыть…', exact: true }).click();
    const content = f.page.locator('.workspace-source-editor .cm-content');
    await content.click();
    await content.press('ControlOrMeta+End');
    await f.page.keyboard.insertText('X');
    await f.page.getByRole('button', { name: 'Закрыть guard.txt', exact: true }).click();
    await expect(f.page.getByRole('tab')).toHaveCount(1);
    await f.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect(f.page.getByRole('alert').last()).toContainText('отменены');
    await f.app.evaluate(({ app }) => app.quit());
    expect(await f.page.evaluate(() => window.desktop.getStorageHealth())).toMatchObject({
      ok: true,
    });
    await f.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.reload(),
    );
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['initialX']);
    expect(await f.page.evaluate((ref) => window.desktop.loadDocument(ref), ref)).toMatchObject({
      ok: true,
    });
    expect(await readFile(path, 'utf8')).toBe('initial');
    await content.press('ControlOrMeta+z');
    await expect(f.page.getByRole('tab', { name: 'guard.txt', exact: true })).toBeVisible();
  } finally {
    await f.forceClose();
  }
});

test('P5.2: выделить всё, copy/cut/paste и Enter используют общую историю', async () => {
  const f = await fixture();
  try {
    const path = join(f.folder, 'clipboard.txt');
    await writeFile(path, 'A😀\r\nB');
    await f.choose([path]);
    await f.page.getByRole('button', { name: 'Открыть…', exact: true }).click();
    await f.page.getByRole('button', { name: 'Выделить всё', exact: true }).click();
    const copied = await f.page.evaluate(() => {
      const data = new window.DataTransfer(),
        content = document.querySelector('.workspace-source-editor .cm-content');
      content.dispatchEvent(
        new window.ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
      );
      return data.getData('text/plain');
    });
    expect(copied).toBe('A😀\nB');
    await f.page.evaluate(() => {
      const data = new window.DataTransfer();
      const content = document.querySelector('.workspace-source-editor .cm-content');
      content.dispatchEvent(
        new window.ClipboardEvent('cut', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['']);
    await f.page.getByRole('button', { name: 'Отменить', exact: true }).click();
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['A😀', 'B']);
    await f.page.getByRole('button', { name: 'Выделить всё', exact: true }).click();
    await f.page.evaluate(() => {
      const data = new window.DataTransfer();
      data.setData('text/plain', 'X\r\nY');
      const content = document.querySelector('.workspace-source-editor .cm-content');
      content.dispatchEvent(
        new window.ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['X', 'Y']);
    const content = f.page.locator('.workspace-source-editor .cm-content');
    await content.press('ControlOrMeta+End');
    await content.press('Enter');
    await f.page.keyboard.insertText('Z');
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(['X', 'Y', 'Z']);
    expect(await readFile(path, 'utf8')).toBe('A😀\r\nB');
  } finally {
    await f.forceClose();
  }
});
