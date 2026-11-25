import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { PortError } from '../../../ports';
import { channels } from '../shared/contracts';
import type { DesktopIpcMap } from '../shared/contracts';
import { openServiceDatabase } from './database';
import type { ServiceDatabase } from './database';
import { rendererUrl, validateRequestSource } from './security';
import { prepareServiceProfile } from './service-files';
import { createLocalServices } from './persistence/local-services';
import type { LocalServices } from './persistence/local-services';
import { createFileIpc } from './file-ipc';

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
  const resetClient = () => {
    fileIpc?.close();
    fileIpc = localServices
      ? createFileIpc(localServices.createClient(next.webContents), async () => {
          const selected = await dialog.showOpenDialog(next, {
            title: 'Открыть документы',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'Текст и Markdown', extensions: ['txt', 'md', 'markdown'] }],
          });
          return selected.canceled ? null : selected.filePaths;
        })
      : null;
  };
  resetClient();
  next.webContents.on('did-navigate', () => {
    if (!quitting) resetClient();
  });
  next.webContents.on('will-prevent-unload', () => {
    exitRequested = false;
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
      if (error) return { ok: false, error };
      if (quitting)
        return {
          ok: false,
          error: { code: 'permission-denied', message: 'Приложение закрывается', retryable: false },
        };
      if (args.length !== 1)
        return {
          ok: false,
          error: { code: 'invalid-input', message: 'Ожидается один запрос', retryable: false },
        };
      const files = fileIpc;
      const task = (async (): Promise<DesktopIpcMap[typeof channel]['response']> => {
        const input = args[0];
        if (
          channel === channels.appInfo ||
          channel === channels.storageHealth ||
          channel === channels.pickOpen
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
        if (!files) return unavailable();
        if (channel === channels.pickOpen) return files.pickOpen(input);
        if (channel === channels.loadDocument) return files.loadDocument(input);
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
