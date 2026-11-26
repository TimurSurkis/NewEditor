import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { PortError } from '../../../ports';
import { channels, closeRequested, resourceNotification } from '../shared/contracts';
import type { DesktopIpcMap } from '../shared/contracts';
import { openServiceDatabase } from './database';
import type { ServiceDatabase } from './database';
import { rendererUrl, validateRequestSource } from './security';
import { prepareServiceProfile } from './service-files';
import { createLocalServices } from './persistence/local-services';
import type { LocalServices } from './persistence/local-services';
import { createFileIpc, fileIpcFailure } from './file-ipc';
import { fields } from './persistence/save-data';

app.setName('NewEditor');
const profile = process.env['NEWEDITOR_USER_DATA'];
if (profile) {
  if (!isAbsolute(profile)) throw new Error('NEWEDITOR_USER_DATA должен быть абсолютным путём');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  app.setPath('userData', profile);
}

let window: BrowserWindow | null = null;
let database: ServiceDatabase | null = null;
let databaseError: PortError | null = null;
let localServices: LocalServices | null = null;
let fileIpc: ReturnType<typeof createFileIpc> | null = null;
const pending = new Set<Promise<unknown>>();
let quitting = false,
  drained = false;
let exitRequested = false;
const unavailable = () => ({
  ok: false as const,
  error:
    databaseError ??
    ({
      code: 'io-error',
      message: 'Служебная база недоступна',
      retryable: false,
    } satisfies PortError),
});

function activateWindow(): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function createWindow(): Promise<void> {
  if (quitting) return;
  const url = rendererUrl(
    process.env['ELECTRON_RENDERER_URL'],
    app.isPackaged,
    fileURLToPath(new URL('../renderer/index.html', import.meta.url)),
  );
  const next = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'NewEditor',
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    },
  });
  window = next;
  let rendererReady = false,
    closeWaiting = false,
    closeApproved = false;
  const resetClient = () => {
    fileIpc?.close();
    fileIpc = localServices
      ? createFileIpc(
          localServices.createClient(next.webContents),
          async () => {
            const selected = await dialog.showOpenDialog(next, {
              title: 'Открыть документы',
              properties: ['openFile', 'multiSelections'],
              filters: [{ name: 'Текст и Markdown', extensions: ['txt', 'md', 'markdown'] }],
            });
            return selected.canceled ? null : selected.filePaths;
          },
          {
            async pickSave(input) {
              const selected = await dialog.showSaveDialog(next, {
                title: 'Сохранить как',
                defaultPath: input.currentPath ?? input.suggestedName,
                filters: [
                  {
                    name: input.format === 'txt' ? 'Текст' : 'Markdown',
                    extensions: input.format === 'txt' ? ['txt'] : ['md', 'markdown'],
                  },
                ],
                properties: ['dontAddToRecent'],
              });
              return selected.canceled ? null : (selected.filePath ?? null);
            },
            async confirmOverwrite(displayName) {
              const result = await dialog.showMessageBox(next, {
                type: 'warning',
                message: `Заменить файл «${displayName}»?`,
                detail:
                  'Существующее содержимое будет сохранено в истории. Если файл изменится после подтверждения, запись будет отклонена.',
                buttons: ['Заменить', 'Отмена'],
                defaultId: 1,
                cancelId: 1,
                noLink: true,
              });
              return result.response === 0;
            },
            async confirmClose(displayName) {
              const result = await dialog.showMessageBox(next, {
                type: 'question',
                message: `Сохранить изменения в «${displayName}»?`,
                buttons: ['Сохранить', 'Не сохранять', 'Отмена'],
                defaultId: 0,
                cancelId: 2,
                noLink: true,
              });
              return result.response === 0 ? 'save' : result.response === 1 ? 'discard' : 'cancel';
            },
          },
          (notification) => {
            if (!next.isDestroyed()) next.webContents.send(resourceNotification, notification);
          },
        )
      : null;
  };
  resetClient();
  next.on('focus', () => {
    const task = fileIpc?.refreshResources(null);
    if (task) {
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
  });
  next.webContents.on('did-navigate', () => {
    rendererReady = false;
    closeWaiting = false;
    closeApproved = false;
    if (!quitting) resetClient();
  });
  next.webContents.on('will-prevent-unload', () => {
    exitRequested = false;
  });
  next.on('close', (event) => {
    if (closeApproved || !rendererReady) {
      closeApproved = false;
      return;
    }
    event.preventDefault();
    if (!closeWaiting) {
      closeWaiting = true;
      next.webContents.send(closeRequested);
    }
  });
  next.setMenuBarVisibility(false);
  next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  next.webContents.on('will-navigate', (event) => event.preventDefault());
  next.webContents.on('will-attach-webview', (event) => event.preventDefault());
  next.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  next.webContents.session.setPermissionCheckHandler(() => false);
  next.once('ready-to-show', () => next.show());
  next.on('closed', () => {
    fileIpc?.close();
    fileIpc = null;
    window = null;
    for (const channel of Object.values(channels)) ipcMain.removeHandler(channel);
    if (exitRequested) app.quit();
  });

  // Обработчики привязаны к конкретному окну и только его главному frame.
  for (const channel of Object.values(channels)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      const error = validateRequestSource(
        event.sender === next.webContents,
        event.senderFrame === next.webContents.mainFrame,
        event.senderFrame?.url,
        url,
      );
      if (error) return fileIpcFailure(channel, error, args[0]);
      if (quitting)
        return fileIpcFailure(
          channel,
          { code: 'permission-denied', message: 'Приложение закрывается', retryable: false },
          args[0],
        );
      if (args.length !== 1)
        return fileIpcFailure(
          channel,
          { code: 'invalid-input', message: 'Ожидается один запрос', retryable: false },
          args[0],
        );
      const files = fileIpc;
      const task = (async (): Promise<DesktopIpcMap[typeof channel]['response']> => {
        const input = args[0];
        if (
          channel === channels.appInfo ||
          channel === channels.storageHealth ||
          channel === channels.pickOpen ||
          channel === channels.windowReady
        ) {
          if (input !== null)
            return {
              ok: false,
              error: {
                code: 'invalid-input',
                message: 'Ожидается пустой запрос',
                retryable: false,
              },
            };
        }
        if (channel === channels.appInfo)
          return { ok: true, value: { appVersion: app.getVersion() } };
        if (channel === channels.windowReady) {
          rendererReady = true;
          return { ok: true, value: null };
        }
        if (channel === channels.resolveClose) {
          try {
            const data = fields(input, ['proceed']);
            if (typeof data['proceed'] !== 'boolean') throw new Error('proceed');
            if (!closeWaiting)
              return {
                ok: false,
                error: { code: 'invalid-input', message: 'Нет запроса закрытия', retryable: false },
              };
            closeWaiting = false;
            if (data['proceed']) {
              closeApproved = true;
              next.close();
            } else exitRequested = false;
            return { ok: true, value: null };
          } catch {
            return {
              ok: false,
              error: {
                code: 'invalid-input',
                message: 'Некорректное подтверждение закрытия',
                retryable: false,
              },
            };
          }
        }
        if (channel === channels.storageHealth) {
          if (!database || !localServices) return unavailable();
          const ready = await localServices.ready;
          if (!ready.ok) return ready;
          try {
            return { ok: true, value: database.health() };
          } catch {
            return {
              ok: false,
              error: { code: 'io-error', message: 'Ошибка проверки SQLite', retryable: true },
            };
          }
        }
        if (!files) return fileIpcFailure(channel, unavailable().error, input);
        if (channel === channels.watchResource) return files.watchResource(input);
        if (channel === channels.unwatchResource) return files.unwatchResource(input);
        if (channel === channels.refreshResources) return files.refreshResources(input);
        if (channel === channels.pickOpen) return files.pickOpen(input);
        if (channel === channels.loadDocument) return files.loadDocument(input);
        if (channel === channels.pickSave) return files.pickSave(input);
        if (channel === channels.saveDocument) return files.saveDocument(input);
        if (channel === channels.getOperation) return files.getOperation(input);
        if (channel === channels.reconcileOperation) return files.reconcileOperation(input);
        if (channel === channels.confirmClose) return files.confirmClose(input);
        return files.removeDraft(input);
      })();
      pending.add(task);
      void task.finally(() => pending.delete(task));
      return task;
    });
  }
  await next.loadURL(url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', activateWindow);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    if (drained) return;
    event.preventDefault();
    if (quitting) return;
    if (window && !window.isDestroyed()) {
      exitRequested = true;
      window.close();
      return;
    }
    quitting = true;
    fileIpc?.close();
    void (async () => {
      await localServices?.ready;
      while (pending.size) await Promise.allSettled([...pending]);
      localServices?.close();
      database?.close();
      drained = true;
      app.quit();
    })().catch(failStartup);
  });
  app.on('activate', () => {
    if (window) activateWindow();
    else void createWindow().catch(failStartup);
  });
  void app
    .whenReady()
    .then(async () => {
      try {
        prepareServiceProfile(app.getPath('userData'));
        database = openServiceDatabase(join(app.getPath('userData'), 'service.sqlite'));
        localServices = createLocalServices(database);
      } catch {
        databaseError = {
          code: 'io-error',
          message: 'Служебная база недоступна или имеет неподдерживаемую схему',
          retryable: false,
        };
      }
      await createWindow();
    })
    .catch(failStartup);
}

function failStartup(error: unknown): void {
  console.error('Не удалось запустить приложение', error);
  app.exit(1);
}
