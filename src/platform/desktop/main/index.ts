import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';
import type { PortError } from '../../../ports';
import { channels } from '../shared/contracts';
import type { DesktopIpcMap } from '../shared/contracts';
import { openServiceDatabase } from './database';
import type { ServiceDatabase } from './database';
import { rendererUrl, validateDiagnosticRequest } from './security';

app.setName('NewEditor');
const profile = process.env['NEWEDITOR_USER_DATA'];
if (profile) {
  if (!isAbsolute(profile)) throw new Error('NEWEDITOR_USER_DATA должен быть абсолютным путём');
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}

let window: BrowserWindow | null = null;
let database: ServiceDatabase | null = null;
let databaseError: PortError | null = null;

function activateWindow(): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function createWindow(): Promise<void> {
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
    window = null;
    for (const channel of Object.values(channels)) ipcMain.removeHandler(channel);
  });

  // Обработчики привязаны к конкретному окну и только его главному frame.
  for (const channel of Object.values(channels)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(
      channel,
      (event, ...args: unknown[]): DesktopIpcMap[typeof channel]['response'] => {
        const error = validateDiagnosticRequest(
          event.sender === next.webContents,
          event.senderFrame === next.webContents.mainFrame,
          event.senderFrame?.url,
          url,
          args,
        );
        if (error) return { ok: false, error };
        if (channel === channels.appInfo) {
          return { ok: true, value: { appVersion: app.getVersion() } };
        }
        if (!database)
          return {
            ok: false,
            error: databaseError ?? {
              code: 'io-error',
              message: 'База не инициализирована',
              retryable: false,
            },
          };
        try {
          return { ok: true, value: database.health() };
        } catch {
          return {
            ok: false,
            error: { code: 'io-error', message: 'Ошибка проверки SQLite', retryable: true },
          };
        }
      },
    );
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
  app.on('before-quit', () => database?.close());
  app.on('activate', () => {
    if (window) activateWindow();
    else void createWindow().catch(failStartup);
  });
  void app
    .whenReady()
    .then(async () => {
      try {
        mkdirSync(app.getPath('userData'), { recursive: true });
        database = openServiceDatabase(join(app.getPath('userData'), 'service.sqlite'));
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
