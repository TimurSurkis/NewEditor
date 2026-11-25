import { test, expect, _electron as electron } from '@playwright/test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixtures = JSON.parse(
  await readFile('docs/specifications/fixtures/spec-markdown-cases.json', 'utf8'),
).cases;
async function start() {
  const profile = await mkdtemp(join(tmpdir(), 'neweditor-markdown-'));
  const executablePath = process.env['NEWEDITOR_EXECUTABLE'];
  const env = {
    ...process.env,
    NEWEDITOR_USER_DATA: profile,
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
  await page.getByRole('button', { name: 'Прототип Markdown', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Прототип Markdown' })).toBeVisible();
  return {
    page,
    app,
    async close() {
      await app.close();
      await rm(profile, { recursive: true, force: true });
    },
  };
}
const source = async (page) => JSON.parse(await page.getByTestId('source-json').textContent());
async function load(page, text) {
  await page.getByText('Загрузить тестовый текст', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'JSON-строка', exact: true }).check();
  await page.getByLabel('Исходный текст для проверки', { exact: true }).fill(JSON.stringify(text));
  await page.getByRole('button', { name: 'Загрузить текст', exact: true }).click();
  await expect.poll(() => source(page)).toBe(text);
  await page.getByText('Загрузить тестовый текст', { exact: true }).click();
}
async function selectText(page, text, mode = 'visual') {
  const editor = page.locator(mode === 'visual' ? '.ProseMirror' : '.cm-content');
  await editor.evaluate((element, text) => {
    element.focus();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.textContent.indexOf(text);
      if (at >= 0) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + text.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return;
      }
    }
    throw new Error(`Не найден видимый текст: ${text}`);
  }, text);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

for (const example of fixtures)
  test(`${example.id}: source → visual → действие → undo/redo`, async () => {
    const session = await start();
    const { page } = session;
    try {
      await load(page, example.source);
      const revision = await page.getByTestId('revision').textContent();
      await page.getByRole('button', { name: 'Визуальный режим', exact: true }).click();
      await expect(page.locator('.ProseMirror')).toBeVisible();
      if (example.action.kind === 'switch-modes') {
        const dispatches = await page.getByTestId('dispatches').textContent();
        for (let i = 0; i < example.action.cycles; i++) {
          await page.getByRole('button', { name: 'Исходный режим', exact: true }).click();
          await page.getByRole('button', { name: 'Визуальный режим', exact: true }).click();
        }
        expect(await source(page)).toBe(example.source);
        expect(await page.getByTestId('revision').textContent()).toBe(revision);
        expect(await page.getByTestId('dispatches').textContent()).toBe(dispatches);
        return;
      }
      if (example.action.kind === 'set-task')
        await page.locator('.ProseMirror input[type="checkbox"]').first().click();
      else if (example.action.kind === 'replace-image-alt') {
        await page.locator('[data-image-alt]').click();
        await page.getByLabel('Описание изображения', { exact: true }).fill(example.action.insert);
        await page.getByRole('button', { name: 'Применить описание', exact: true }).click();
      } else {
        await selectText(page, example.action.select);
        if (example.action.kind === 'replace-text')
          await page.keyboard.insertText(example.action.insert);
        else
          await page
            .getByRole('button', {
              name:
                example.action.kind === 'set-heading'
                  ? 'Заголовок 2'
                  : example.action.mark === 'strong'
                    ? 'Жирный'
                    : 'Курсив',
              exact: true,
            })
            .click();
      }
      await expect.poll(() => source(page)).toBe(example.expected);
      await page.getByRole('button', { name: 'Исходный режим', exact: true }).click();
      await page.getByRole('button', { name: 'Отменить', exact: true }).click();
      await expect.poll(() => source(page)).toBe(example.source);
      await page.getByRole('button', { name: 'Визуальный режим', exact: true }).click();
      await page.getByRole('button', { name: 'Повторить', exact: true }).click();
      await expect.poll(() => source(page)).toBe(example.expected);
      await expect(page.getByRole('alert')).toHaveCount(0);
    } finally {
      await session.close();
    }
  });

test('source- и visual-правки используют общую историю и сохраняют смешанные переводы', async () => {
  const session = await start(),
    { page } = session;
  try {
    await load(page, 'Первая\r\n\r\nВторая\n\nТретья\r');
    await selectText(page, 'Первая', 'source');
    await page.keyboard.insertText('Начало');
    await expect.poll(() => source(page)).toBe('Начало\r\n\r\nВторая\n\nТретья\r');
    await page.getByRole('button', { name: 'Визуальный режим', exact: true }).click();
    await selectText(page, 'Вторая');
    await page.keyboard.insertText('Середина');
    await expect.poll(() => source(page)).toBe('Начало\r\n\r\nСередина\n\nТретья\r');
    await page.getByRole('button', { name: 'Отменить', exact: true }).click();
    await page.getByRole('button', { name: 'Исходный режим', exact: true }).click();
    await page.getByRole('button', { name: 'Отменить', exact: true }).click();
    await expect.poll(() => source(page)).toBe('Первая\r\n\r\nВторая\n\nТретья\r');
  } finally {
    await session.close();
  }
});

for (const mode of ['source', 'visual']) {
  test(`ME-04: ${mode}, быстрые отдельные композиции с повторяющимися буквами отменяются отдельно`, async () => {
    const session = await start(),
      { app, page } = session;
    try {
      await load(page, 'a');
      if (mode === 'visual')
        await page.getByRole('button', { name: 'Визуальный режим', exact: true }).click();
      await page.locator(mode === 'visual' ? '.ProseMirror' : '.cm-content').click();
      await page.keyboard.press('End');
      const cdp = await app.context().newCDPSession(page);
      for (let i = 0; i < 2; i++) {
        await cdp.send('Input.imeSetComposition', {
          text: 'a',
          selectionStart: 1,
          selectionEnd: 1,
        });
        await cdp.send('Input.insertText', { text: 'a' });
      }
      await expect.poll(() => source(page)).toBe('aaa');
      await page.getByRole('button', { name: 'Отменить', exact: true }).click();
      await expect.poll(() => source(page)).toBe('aa');
      await page.getByRole('button', { name: 'Отменить', exact: true }).click();
      await expect.poll(() => source(page)).toBe('a');
    } finally {
      await session.close();
    }
  });
  test(`ME-04/05: ${mode}, IME одна группа; снимок и смена режима ждут flush`, async () => {
    const session = await start(),
      { app, page } = session;
    try {
      await load(page, '');
      if (mode === 'visual')
        await page.getByRole('button', { name: 'Визуальный режим', exact: true }).click();
      await page.locator(mode === 'visual' ? '.ProseMirror' : '.cm-content').click();
      const cdp = await app.context().newCDPSession(page);
      await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
      expect(await source(page)).toBe('');
      await cdp.send('Input.imeSetComposition', {
        text: '日本語',
        selectionStart: 3,
        selectionEnd: 3,
      });
      await page.getByRole('button', { name: 'Проверить снимок', exact: true }).click();
      await page
        .getByRole('button', {
          name: mode === 'visual' ? 'Исходный режим' : 'Визуальный режим',
          exact: true,
        })
        .click();
      expect(await page.getByTestId('mode').textContent()).toBe(mode);
      await expect(page.getByLabel('Снимок после flush', { exact: true })).toHaveCount(0);
      await cdp.send('Input.insertText', { text: '日本語' });
      await expect.poll(() => source(page)).toBe('日本語');
      await expect(page.getByLabel('Снимок после flush', { exact: true })).toHaveValue('日本語');
      await expect(page.getByTestId('mode')).toHaveText(mode === 'visual' ? 'source' : 'visual');
      await page.getByRole('button', { name: 'Отменить', exact: true }).click();
      await expect.poll(() => source(page)).toBe('');
    } finally {
      await session.close();
    }
  });
  test(`ME-02: ${mode}, устаревшая композиция остаётся доступной и не меняет новую ревизию`, async () => {
    const session = await start(),
      { app, page } = session;
    try {
      await load(page, '');
      await page.getByText('Проверка конкурентного изменения', { exact: true }).click();
      if (mode === 'visual')
        await page.getByRole('button', { name: 'Визуальный режим', exact: true }).click();
      await page.locator(mode === 'visual' ? '.ProseMirror' : '.cm-content').click();
      const cdp = await app.context().newCDPSession(page);
      await cdp.send('Input.imeSetComposition', {
        text: '日本語',
        selectionStart: 3,
        selectionEnd: 3,
      });
      await page.getByRole('button', { name: 'Имитировать внешнюю правку', exact: true }).click();
      await cdp.send('Input.insertText', { text: '日本語' });
      await expect(page.getByRole('alert')).toContainText('Ревизия устарела');
      expect(await source(page)).toBe('\nВнешняя правка.');
      await expect(page.getByLabel('Неподтверждённый ввод', { exact: true })).toHaveValue('日本語');
      await page
        .getByRole('button', {
          name: mode === 'visual' ? 'Исходный режим' : 'Визуальный режим',
          exact: true,
        })
        .click();
      await expect(page.getByTestId('mode')).toHaveText(mode);
      await page
        .getByRole('button', { name: 'Отбросить неподтверждённый ввод', exact: true })
        .click();
      expect(await source(page)).toBe('\nВнешняя правка.');
      await expect(page.getByRole('alert')).toHaveCount(0);
    } finally {
      await session.close();
    }
  });
}

test('ME-03: metadata-only кадр не меняет DOM/исходник и принимает следующую правку', async () => {
  const session = await start(),
    { page } = session;
  try {
    await load(page, 'текст');
    await page.getByRole('button', { name: 'Визуальный режим', exact: true }).click();
    const paragraph = await page.locator('.ProseMirror p').elementHandle(),
      revision = await page.getByTestId('revision').textContent(),
      dispatches = await page.getByTestId('dispatches').textContent();
    await page.getByText('Проверка конкурентного изменения', { exact: true }).click();
    await page.getByRole('button', { name: 'Сменить BOM (тест)', exact: true }).click();
    expect(await source(page)).toBe('текст');
    expect(await page.getByTestId('revision').textContent()).not.toBe(revision);
    expect(
      await paragraph.evaluate((node) => node === document.querySelector('.ProseMirror p')),
    ).toBe(true);
    expect(await page.getByTestId('dispatches').textContent()).toBe(dispatches);
    await selectText(page, 'текст');
    await page.keyboard.insertText('новый');
    await expect.poll(() => source(page)).toBe('новый');
  } finally {
    await session.close();
  }
});

test('ME-07: новый блок рядом с HTML не переписывает защищённый исходник', async () => {
  const session = await start(),
    { page } = session;
  try {
    const initial = '<unknown value="x">  raw </unknown>\n\nАбзац.\n';
    await load(page, initial);
    await page.getByRole('button', { name: 'Визуальный режим', exact: true }).click();
    await selectText(page, 'Абзац.');
    await page.keyboard.insertText('Новый\n\nВторой');
    await expect
      .poll(() => source(page))
      .toBe('<unknown value="x">  raw </unknown>\n\nНовый\n\nВторой\n');
    await expect(page.locator('.ProseMirror [data-opaque]')).toContainText(
      '<unknown value="x">  raw </unknown>',
    );
  } finally {
    await session.close();
  }
});

test('HTML остаётся текстом, защищённый фрагмент открывается в source', async () => {
  const session = await start(),
    { page } = session;
  try {
    const invalidSelections = [];
    page.on('console', (message) => {
      if (message.text().includes('TextSelection endpoint')) invalidSelections.push(message.text());
    });
    const text = '<script>window.__markdownExecuted = true</script>\n\nАбзац.\n';
    await load(page, text);
    await page.getByRole('button', { name: 'Визуальный режим', exact: true }).click();
    await expect(page.locator('.ProseMirror script')).toHaveCount(0);
    expect(await page.evaluate(() => typeof window.__markdownExecuted)).toBe('undefined');
    await page.locator('.ProseMirror [data-opaque]').dblclick();
    await expect(page.getByTestId('mode')).toHaveText('source');
    expect(await source(page)).toBe(text);
    expect(invalidSelections).toEqual([]);
  } finally {
    await session.close();
  }
});

test('ME-06: выделения в скрытой ссылке, около emoji и CRLF переживают смену режима', async () => {
  const session = await start(),
    { page } = session;
  try {
    const text = 'A😀Б\r\n\r\n[метка](https://example.test/path)\r\n\r\n<unknown>raw</unknown>\r\n';
    await load(page, text);
    for (const selected of ['😀', 'example.test', 'Б', 'raw']) {
      await selectText(page, selected, 'source');
      const selection = await page.getByTestId('selection').textContent();
      await page.getByRole('button', { name: 'Визуальный режим', exact: true }).click();
      if (selected === 'raw')
        await expect(
          page.locator('.ProseMirror [data-opaque].ProseMirror-selectednode'),
        ).toHaveCount(1);
      await page.getByRole('button', { name: 'Исходный режим', exact: true }).click();
      expect(await page.getByTestId('selection').textContent()).toBe(selection);
      expect(await source(page)).toBe(text);
    }
  } finally {
    await session.close();
  }
});

test('ME-08: горячие клавиши двух движков обращаются к общей undo/redo', async () => {
  const session = await start(),
    { page } = session;
  try {
    await load(page, 'один');
    await selectText(page, 'один', 'source');
    await page.keyboard.insertText('два');
    await page.getByRole('button', { name: 'Визуальный режим', exact: true }).click();
    await selectText(page, 'два');
    await page.keyboard.insertText('три');
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+z`);
    await expect.poll(() => source(page)).toBe('два');
    await page.getByRole('button', { name: 'Исходный режим', exact: true }).click();
    await page.keyboard.press(`${mod}+z`);
    await expect.poll(() => source(page)).toBe('один');
    await page.keyboard.press(`${mod}+Shift+z`);
    await expect.poll(() => source(page)).toBe('два');
  } finally {
    await session.close();
  }
});

test('ME-09: замеры на 10 КБ, 100 КБ и 1 МБ без потери правок', async () => {
  test.setTimeout(120_000);
  const session = await start(),
    { page } = session,
    measurements = [];
  try {
    for (const bytes of [10 * 1024, 100 * 1024, 1024 * 1024]) {
      await page.getByRole('button', { name: 'Исходный режим', exact: true }).click();
      const block =
        '## Heading\n\nParagraph with **bold** and [link](/path). ' +
        'Normal text. '.repeat(15) +
        '\n\n';
      const text = block.repeat(Math.ceil(bytes / block.length)).slice(0, bytes);
      await load(page, text);
      const parseMs = Number(await page.getByTestId('parse-ms').textContent());
      await page.getByRole('button', { name: 'Визуальный режим', exact: true }).click();
      await expect(page.getByTestId('mode')).toHaveText('visual');
      const editorMs = Number(await page.getByTestId('editor-ms').textContent());
      await selectText(page, 'Paragraph');
      const start = await page.evaluate(() => performance.now());
      await page.keyboard.insertText('Edited');
      await expect.poll(() => source(page)).toBe(text.replace('Paragraph', 'Edited'));
      const inputMs = (await page.evaluate(() => performance.now())) - start;
      await page.getByRole('button', { name: 'Отменить', exact: true }).click();
      await expect.poll(() => source(page)).toBe(text);
      await page.getByRole('button', { name: 'Исходный режим', exact: true }).click();
      const sourceEditorMs = Number(await page.getByTestId('editor-ms').textContent());
      await selectText(page, 'Paragraph', 'source');
      const sourceStart = await page.evaluate(() => performance.now());
      await page.keyboard.insertText('Edited');
      await expect.poll(() => source(page)).toBe(text.replace('Paragraph', 'Edited'));
      const sourceInputMs = (await page.evaluate(() => performance.now())) - sourceStart;
      measurements.push({
        bytes,
        parseMs,
        editorMs,
        inputMs: Math.round(inputMs),
        sourceEditorMs,
        sourceInputMs: Math.round(sourceInputMs),
      });
      await page.getByRole('button', { name: 'Отменить', exact: true }).click();
      await expect.poll(() => source(page)).toBe(text);
    }
    console.log('MARKDOWN_BENCHMARK', JSON.stringify(measurements));
    await test.info().attach('markdown-benchmark.json', {
      body: JSON.stringify(measurements, null, 2),
      contentType: 'application/json',
    });
  } finally {
    await session.close();
  }
});
