# Результаты каркаса Electron P1

Дата: 2026-11-24.
Основание: [спецификация](../specifications/spec-desktop-bootstrap.md), [план](plan-desktop-v1.md).
Статус: **P1 завершён на доступной платформе Linux x64**.

## Реализация

- Один npm-проект с точными версиями, lockfile, `.nvmrc`, строгим TypeScript и раздельной проверкой main/renderer.
- electron-vite: main, sandbox-preload в CommonJS, React renderer. Публичные точки входа `core`, `ports`, `formats`, `application`, `ui`; логика документа ещё не реализована.
- Одно окно и один main на профиль. Bridge содержит только две именованные диагностические операции; SQL, пути, универсальный IPC не предоставляются.
- SQLite в main: миграция схемы 1, WAL, закрытие соединения, health-транзакция. Ошибка БД отображается без удаления существующей базы.
- ESLint, Prettier, AST-проверка модульных импортов, Vitest, native-набор и Playwright. Конфигурация electron-builder для Linux/Windows/macOS; проверенный артефакт пока только Linux-каталог.

Ключевые исходники: [main](../../src/platform/desktop/main/index.ts), [SQLite](../../src/platform/desktop/main/database.ts), [preload](../../src/platform/desktop/preload/index.ts), [UI](../../src/ui/components/App.tsx), [проверка границ](../../scripts/check-boundaries.mjs).

## Среда и совместимость

Linux x64, доступный DISPLAY `:0`, без Xvfb. Инструменты: Node.js 24.11.1, npm 11.6.2, TypeScript 6.0.3. Electron 45.4.1 содержит Node.js 24.22.3, module ABI 150. React 19.3.1, better-sqlite3 13.2.0. Полный набор — в `package.json`/lockfile и [архитектуре](../specifications/spec-architecture.md).

Изменение первоначального выбора TypeScript 7.0.2 → 6.0.3 устраняет несовместимый peer-диапазон typescript-eslint 8.74.0 (`<6.1.0`). Обновление обратно возможно после появления совместимого анализа и повторения проверок. Глобальная среда пользователя не менялась.

`electron-builder install-app-deps` успешно подготавливает better-sqlite3. Эта версия использует N-API prebuild `prebuilds/linux-x64.node`, а не отдельный скомпилированный `build/Release/better_sqlite3.node`. Проверки выполнены самим Electron; успешный запуск под Node не использован вместо них. В артефакте бинарник находится в `resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/`; main загружает его через виртуальный путь внутри собственного asar.

## Выполненные проверки

| Проверка | Результат |
| --- | --- |
| `npm install` | Установка и подготовка нативных зависимостей прошли без peer-конфликтов |
| `npm ci` | Чистая установка по lockfile и подготовка нативных зависимостей прошли; последующие проверки повторены |
| `npm run check` | Типы main/renderer, ESLint, границы модулей, Prettier и 13 unit-тестов прошли |
| `npm run test:native` | 4 проверки прошли: runtime Electron, миграция/повторное открытие/health/commit/rollback, новая схема, ошибка миграции |
| `npm run build` | Собраны main, preload и renderer |
| `npm run test:electron` | 2 сценария прошли: bridge/изоляция/SQLite/навигация/второй экземпляр; повреждённая БД без сброса файла |
| `npm run test:dev` | Те же 2 сценария прошли с renderer на настоящем Vite dev-сервере; сервер завершён после тестов |
| `npm run dist:dir` | Создан `dist/linux-unpacked/neweditor` с asar и нативным модулем |
| `NEWEDITOR_EXECUTABLE=… npm run test:electron` | Те же 2 сценария прошли с `app.isPackaged: true`, sandbox включён, main выполняет SQLite-транзакцию; путь загруженного native-модуля внутри собственного asar проверен тестом |
| `npm audit --omit=dev` | Уязвимостей production npm-зависимостей не найдено |
| Документация и контракты | Проверены 10 Markdown-файлов, 72 локальные ссылки, статусы 45 задач и 12 fixtures; контракты P0 повторно скомпилированы TypeScript 6.0.3 |

Unit-набор: [безопасность](../../tests/unit/security.test.ts), [границы](../../tests/unit/boundaries.test.mjs). Интеграционные наборы: [SQLite](../../tests/native/database.test.mjs), [Electron](../../tests/electron/desktop.spec.mjs). Тестовые профили создаются отдельно; основной профиль не затрагивается. Команды запуска и матрица сборки приведены в спецификации P1.

## Ограничения и следующие проверки

- Windows x64 и macOS arm64/x64 не собирались и не запускались. Эти строки матрицы остаются открытыми для P8.
- Linux AppImage как пакет пока не проверен; P1 проверяет `--dir`, а не установку/доставку версии.
- Полный `npm audit` сообщает 6 moderate-позиций, связанных с одной уязвимостью minimatch `GHSA-g3hv-75wg-m249` в цепочках electron-builder/app-builder-lib/@electron/universal. Это инструменты сборки, не production-зависимости; они получают только доверенную конфигурацию проекта. Автоматический downgrade builder или major override minimatch не применён: он требует отдельной проверки упаковки, включая macOS. Пересмотреть перед P8 и при обновлении builder. High/critical не обнаружены.
- Редактирование документов, реестр файлов, история, авточерновики и восстановление ещё не реализованы; не следует использовать каркас для хранения пользовательского текста.
- Первоначальное имя пакета/окна `NewEditor` техническое и не фиксирует окончательное название продукта.
