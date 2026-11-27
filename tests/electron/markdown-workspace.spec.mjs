import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function fixture(source, bom = false) {
  const folder = await mkdtemp(join(tmpdir(), 'neweditor-md-workspace-')),
    path = join(folder, 'Заметки.md');
  const original = Buffer.concat([
    bom ? Buffer.from([239, 187, 191]) : Buffer.alloc(0),
    Buffer.from(source),
  ]);
  await writeFile(path, original);
  const executablePath = process.env.NEWEDITOR_EXECUTABLE,
    env = {
      ...process.env,
      NEWEDITOR_USER_DATA: join(folder, 'profile'),
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
  const choose = async (openPath = path, savePath = null, close = 2) =>
    app.evaluate(
      ({ dialog }, input) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.openPath] });
        dialog.showSaveDialog = async () => ({
          canceled: !input.savePath,
          filePath: input.savePath,
        });
        dialog.showMessageBox = async () => {
          dialog.showMessageBox.calls++;
          return { response: input.close, checkboxChecked: false };
        };
        dialog.showMessageBox.calls = 0;
      },
      { openPath, savePath, close },
    );
  await choose();
  await page.getByRole('button', { name: 'Открыть…', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  const mode = async (visual) => {
    await page
      .getByRole('button', { name: visual ? 'Визуальный режим' : 'Исходный режим', exact: true })
      .click();
    await expect(
      page.locator(
        visual ? '.workspace-visual-editor .ProseMirror' : '.workspace-source-editor .cm-content',
      ),
    ).toBeVisible();
  };
  const search = async (query, replacement) => {
    if (!(await page.getByRole('textbox', { name: 'Найти', exact: true }).count()))
      await page.getByRole('button', { name: 'Поиск и замена', exact: true }).click();
    await page.getByRole('textbox', { name: 'Найти', exact: true }).fill(query);
    if (replacement !== undefined)
      await page.getByRole('textbox', { name: 'Заменить на', exact: true }).fill(replacement);
  };
  const appendVisual = async (text) => {
    const paragraph = page.locator('.workspace-visual-editor .ProseMirror p').last();
    await paragraph.click();
    await paragraph.press('End');
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
  return { folder, path, app, page, choose, mode, search, appendVisual, cleanup, original };
}

test('P6.2 increment: mode/format/undo/save/reopen используют файловую сессию и точные CRLF/BOM', async () => {
  const source = '# Title\r\n\r\n_before_ word e\u0301😀\r\n',
    f = await fixture(source, true);
  try {
    const tabId = await f.page.getByRole('tab').getAttribute('id');
    const versions = () =>
      f.app.evaluate(({ app }) => {
        const require = process
            .getBuiltinModule('module')
            .createRequire(`${app.getAppPath()}/package.json`),
          Database = require('better-sqlite3');
        const db = new Database(
          process.getBuiltinModule('path').join(app.getPath('userData'), 'service.sqlite'),
        );
        try {
          return db.prepare('SELECT COUNT(*) AS n FROM saved_versions').get().n;
        } finally {
          db.close();
        }
      });
    const initialVersions = await versions();
    await f.mode(true);
    await f.mode(false);
    await f.mode(true);
    await expect(f.page.getByTestId('save-state')).toHaveText('Сохранено');
    expect(await versions()).toBe(initialVersions);
    expect(await readFile(f.path)).toEqual(f.original);
    await f.search('word');
    await f.page.getByRole('button', { name: 'Следующее', exact: true }).click();
    await f.page.getByRole('button', { name: 'Поиск и замена', exact: true }).click();
    await f.page.getByRole('button', { name: 'Жирный', exact: true }).click();
    await expect(f.page.locator('.workspace-visual-editor strong')).toHaveText('word');
    await f.page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(f.page.getByTestId('save-state')).toHaveText('Сохранено');
    const expected = source.replace('word', '**word**');
    expect(await readFile(f.path)).toEqual(
      Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(expected)]),
    );
    await f.mode(false);
    await f.page.getByRole('button', { name: 'Отменить', exact: true }).click();
    await expect(f.page.getByTestId('save-state')).toHaveText('Есть несохранённые изменения');
    await f.mode(true);
    await expect(f.page.locator('.workspace-visual-editor strong')).toHaveCount(0);
    await f.page.getByRole('button', { name: 'Повторить', exact: true }).click();
    await expect(f.page.locator('.workspace-visual-editor strong')).toHaveText('word');
    await expect(f.page.getByTestId('save-state')).toHaveText('Сохранено');
    expect(await versions()).toBe(initialVersions + 1);
    expect(await f.page.getByRole('tab').getAttribute('id')).toBe(tabId);
    await f.page.getByRole('button', { name: 'Закрыть Заметки.md', exact: true }).click();
    await expect(f.page.getByRole('tab')).toHaveCount(0);
    await f.page.getByRole('button', { name: 'Открыть…', exact: true }).click();
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(
      expected.split('\r\n'),
    );
    await expect(f.page.getByLabel('UTF-8 BOM', { exact: true })).toBeChecked();
  } finally {
    await f.cleanup();
  }
});

test('P6.2 increment: режимы/история двух MD изолированы, TXT не получает visual', async () => {
  const f = await fixture('# First\n\nA\n');
  try {
    await f.mode(true);
    const second = join(f.folder, 'Second.md');
    await writeFile(second, '# Second\n\nB\n');
    await f.choose(second);
    await f.page.getByRole('button', { name: 'Открыть…', exact: true }).click();
    await expect(f.page.locator('.workspace-source-editor .cm-content')).toBeVisible();
    await f.mode(true);
    await f.appendVisual('!');
    await f.page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(f.page.getByTestId('save-state')).toHaveText('Сохранено');
    await f.page.getByRole('tab', { name: 'Заметки.md', exact: true }).click();
    await expect(f.page.locator('.workspace-visual-editor h1')).toHaveText('First');
    await f.appendVisual('?');
    await f.page.getByRole('button', { name: 'Отменить', exact: true }).click();
    await expect(f.page.locator('.workspace-visual-editor p')).toHaveText('A');
    await f.page.getByRole('tab', { name: 'Second.md', exact: true }).click();
    await expect(f.page.locator('.workspace-visual-editor p')).toHaveText('B!');
    expect(await readFile(f.path, 'utf8')).toBe('# First\n\nA\n');
    expect(await readFile(second, 'utf8')).toBe('# Second\n\nB\\!\n');
    await f.page.getByRole('button', { name: 'Новый TXT', exact: true }).click();
    await expect(f.page.getByRole('button', { name: 'Визуальный режим', exact: true })).toHaveCount(
      0,
    );
    await expect(f.page.locator('.workspace-source-editor .cm-content')).toBeVisible();
  } finally {
    await f.cleanup();
  }
});

test('P6.2 increment: видимый find остаётся visual, URL/replace-all открывают source и общую undo', async () => {
  const source = 'Visible word [label](https://example.test/path).\n',
    f = await fixture(source);
  try {
    await f.mode(true);
    await f.search('word', '$1');
    await f.page.getByRole('button', { name: 'Следующее', exact: true }).click();
    await expect(
      f.page.getByRole('button', { name: 'Визуальный режим', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await f.search('example');
    await f.page.getByRole('button', { name: 'Следующее', exact: true }).click();
    await expect(f.page.locator('.workspace-source-editor .cm-content')).toBeVisible();
    await f.search('word');
    await f.mode(true);
    await f.page.getByRole('button', { name: 'Заменить всё', exact: true }).click();
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText([
      'Visible $1 [label](https://example.test/path).',
      '',
    ]);
    await f.page.getByRole('button', { name: 'Отменить', exact: true }).click();
    await expect(f.page.locator('.workspace-source-editor .cm-line')).toHaveText(
      source.split('\n'),
    );
    expect(await readFile(f.path)).toEqual(f.original);
  } finally {
    await f.cleanup();
  }
});

test('P6.2 increment: HTML/remote images не исполняются, paste только plain text, отказ сохраняет payload', async () => {
  const f = await fixture(
    '<script>globalThis.mdExecuted=true</script>\n\n![pixel](https://remote.test/pixel.png)\n\nParagraph.\n',
  );
  const remote = [];
  f.page.on('request', (request) => {
    if (/remote\.test/.test(request.url())) remote.push(request.url());
  });
  try {
    await f.mode(true);
    await expect(
      f.page.locator(
        '.workspace-visual-editor script, .workspace-visual-editor img:not(.ProseMirror-separator), .workspace-visual-editor img[src], .workspace-visual-editor img[srcset], .workspace-visual-editor iframe, .workspace-visual-editor [href]',
      ),
    ).toHaveCount(0);
    expect(await f.page.evaluate(() => globalThis.mdExecuted)).toBeUndefined();
    await f.page.locator('.workspace-visual-editor [data-opaque]').dblclick();
    await expect(f.page.locator('.workspace-source-editor .cm-content')).toBeVisible();
    await f.mode(true);
    const paragraph = f.page.locator('.workspace-visual-editor p').last();
    await paragraph.click();
    await paragraph.press('End');
    const paste = (plain, html) =>
      f.page.evaluate(
        ({ plain, html }) => {
          const data = new window.DataTransfer();
          if (plain !== null) data.setData('text/plain', plain);
          data.setData('text/html', html);
          document.querySelector('.workspace-visual-editor .ProseMirror').dispatchEvent(
            new window.ClipboardEvent('paste', {
              clipboardData: data,
              bubbles: true,
              cancelable: true,
            }),
          );
        },
        { plain, html },
      );
    await paste(
      '*literal*',
      '<img src="https://remote.test/evil" onerror="globalThis.mdExecuted=true">',
    );
    await expect(paragraph).toHaveText('Paragraph.*literal*');
    await expect(
      f.page.locator(
        '.workspace-visual-editor em, .workspace-visual-editor strong, .workspace-visual-editor img:not(.ProseMirror-separator), .workspace-visual-editor img[src]',
      ),
    ).toHaveCount(0);
    await paste(null, '<script>globalThis.mdExecuted=true</script>');
    await expect(f.page.getByRole('alert')).toContainText('HTML не вставляется');
    await paste('line1\nline2', '<b>ignored</b>');
    await expect(f.page.getByLabel('Неподтверждённый ввод', { exact: true })).toHaveValue(
      'line1\nline2',
    );
    await expect(
      f.page.getByRole('button', { name: 'Исходный режим', exact: true }),
    ).toBeDisabled();
    await f.page
      .getByRole('button', { name: 'Отбросить неподтверждённый ввод', exact: true })
      .click();
    await f.mode(false);
    await expect(f.page.locator('.workspace-source-editor .cm-content')).toContainText(
      'Paragraph.\\*literal\\*',
    );
    expect(remote).toEqual([]);
    expect(await f.page.evaluate(() => globalThis.mdExecuted)).toBeUndefined();
    expect(await readFile(f.path)).toEqual(f.original);
  } finally {
    await f.cleanup();
  }
});

test('P6.2 increment: source→visual и save/close ждут настоящий CDP-IME', async () => {
  const source = '# Doc\n\nA\n',
    f = await fixture(source);
  try {
    const cdp = await f.app.context().newCDPSession(f.page),
      content = f.page.locator('.workspace-source-editor .cm-content');
    await content.click();
    await content.press('ControlOrMeta+End');
    await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
    await f.page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent === 'Визуальный режим')
        .click(),
    );
    await expect(f.page.locator('.workspace-source-editor .cm-content')).toBeVisible();
    await cdp.send('Input.insertText', { text: '日本' });
    await expect(f.page.locator('.workspace-visual-editor .ProseMirror')).toBeVisible();
    const paragraph = f.page.locator('.workspace-visual-editor p').last();
    await paragraph.click();
    await f.page.locator('.workspace-visual-editor .ProseMirror').press('ControlOrMeta+End');
    await cdp.send('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 });
    await expect(
      f.page.getByText('Композиция: завершите ввод для перехода', { exact: true }),
    ).toBeVisible();
    await f.page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent === 'Сохранить')
        .click(),
    );
    await expect(f.page.getByTestId('save-state')).toHaveText('Сохранение…');
    expect(await readFile(f.path, 'utf8')).toBe(source);
    await cdp.send('Input.insertText', { text: '中' });
    await expect(f.page.getByTestId('save-state')).toHaveText('Сохранено');
    expect(await readFile(f.path, 'utf8')).toBe(source + '日本中');
    await paragraph.click();
    await f.page.locator('.workspace-visual-editor .ProseMirror').press('ControlOrMeta+End');
    await expect
      .poll(() =>
        paragraph.evaluate((element) => {
          const selection = window.getSelection(),
            range = document.createRange();
          range.selectNodeContents(element);
          range.setEnd(selection.anchorNode, selection.anchorOffset);
          return selection.isCollapsed && range.toString().length === element.textContent.length;
        }),
      )
      .toBe(true);
    await cdp.send('Input.imeSetComposition', { text: '文', selectionStart: 1, selectionEnd: 1 });
    await expect(
      f.page.getByText('Композиция: завершите ввод для перехода', { exact: true }),
    ).toBeVisible();
    await f.page.evaluate(() =>
      document.querySelector('button[aria-label="Закрыть Заметки.md"]').click(),
    );
    expect(await f.app.evaluate(({ dialog }) => dialog.showMessageBox.calls)).toBe(0);
    await cdp.send('Input.insertText', { text: '文' });
    await expect(f.page.getByRole('alert').last()).toContainText('Закрытие отменено');
    await expect(f.page.getByRole('tab')).toHaveCount(1);
    expect(await readFile(f.path, 'utf8')).toBe(source + '日本中');
    await f.choose(f.path, null, 0);
    await f.page.getByRole('button', { name: 'Закрыть Заметки.md', exact: true }).click();
    await expect(f.page.getByRole('tab')).toHaveCount(0);
    expect(await readFile(f.path, 'utf8')).toBe(source + '日本中文');
  } finally {
    await f.cleanup();
  }
});

test('P6.2 increment: visual перечитывает clean; dirty-конфликт сохраняет рабочую копию через Save As', async () => {
  const f = await fixture('# Doc\n\nOriginal.\n');
  try {
    await f.mode(true);
    await writeFile(f.path, '# Doc\n\nExternal.\n');
    await expect(f.page.locator('.workspace-visual-editor p')).toHaveText('External.');
    await f.appendVisual('ours');
    await writeFile(f.path, '# Doc\n\nOther.\n');
    await expect(f.page.getByLabel('Внешний файл', { exact: true })).toHaveText(
      '# Doc\n\nOther.\n',
    );
    await expect(f.page.locator('.workspace-visual-editor p')).toHaveText('External.ours');
    const copy = join(f.folder, 'Copy.md');
    await f.choose(f.path, copy);
    await f.page.getByRole('button', { name: 'Сохранить копию…', exact: true }).click();
    await expect(f.page.getByRole('tab', { name: 'Copy.md', exact: true })).toBeVisible();
    await expect(f.page.getByTestId('save-state')).toHaveText('Сохранено');
    expect(await readFile(copy, 'utf8')).toBe('# Doc\n\nExternal.ours\n');
    expect(await readFile(f.path, 'utf8')).toBe('# Doc\n\nOther.\n');
    await expect(f.page.locator('.workspace-visual-editor p')).toHaveText('External.ours');
  } finally {
    await f.cleanup();
  }
});

test('P6.2 increment: IME внутри inert-ссылки сохраняет mark, URL/title и соседние байты', async () => {
  const source = '# Doc\r\n\r\n[слово](https://example.test/path "Title") tail\r\n',
    f = await fixture(source);
  try {
    await f.mode(true);
    const link = f.page.locator('.workspace-visual-editor [data-markdown-link]');
    await expect(link).toHaveText('слово');
    await expect(link).toHaveAttribute('data-markdown-link', String(source.indexOf('[')));
    await expect(f.page.locator('.workspace-visual-editor [href]')).toHaveCount(0);
    await f.search('ов');
    await f.page.getByRole('button', { name: 'Следующее', exact: true }).click();
    await f.page.getByRole('button', { name: 'Поиск и замена', exact: true }).click();
    await f.page.locator('.workspace-visual-editor .ProseMirror').focus();
    const cdp = await f.app.context().newCDPSession(f.page);
    await cdp.send('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: '中' });
    await expect(link).toHaveText('сл中о');
    await expect(f.page.getByLabel('Неподтверждённый ввод', { exact: true })).toHaveCount(0);
    await f.page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(f.page.getByTestId('save-state')).toHaveText('Сохранено');
    expect(await readFile(f.path, 'utf8')).toBe(source.replace('слово', 'сл中о'));
    await f.page.getByRole('button', { name: 'Отменить', exact: true }).click();
    await expect(link).toHaveText('слово');
  } finally {
    await f.cleanup();
  }
});
