# Контракты модулей и локального транспорта

Статус: **контракты P0.2 зафиксированы для P1–P4**.
Редакция: 2026-11-25.
Основание: [архитектура](spec-architecture.md), [модель документа](spec-document-model.md). Детали локального адаптера: [сохранение P4](spec-local-persistence.md).

Ниже описаны публичные границы. В P2 реализованы ядро и сценарии приложения, добавлен тестовый адаптер хранения; реальные файловые операции и основной IPC относятся к P4–P7. Порты используют обычные данные и Promise; реализации подключаются в точке запуска. Результаты: [отчёт P2](../trackers/track-document-core.md).

Результат P4.2–P4.4: main-only фабрика реализует полный DocumentStore с журналом и HistoryStore с реестром/правами владельца. Черновики, наблюдение и файловый IPC/UI ещё не подключены; подробности — в спецификации локального хранения.

## 1. Владение контрактами

| Контракт | Владелец | Реализация |
| --- | --- | --- |
| Document, снимки, транзакции, Result | `core` | Чистая логика P2 |
| Хранилища, ошибки ввода/вывода, DTO операций | `ports` | Electron main через IPC; позднее HTTP |
| DocumentApplication, SessionView | `application` | Управление сессиями и сценариями |
| EditorFrame, EditorHost, EditorInstance | `ui/editors` | CodeMirror и ProseMirror, см. спецификацию Markdown |
| DesktopIpcMap и файловые диалоги | `platform/desktop` | Main/preload/renderer |

## 2. Типы операций и порты

Импорт в примере обозначает типы блока из спецификации модели. В реализации они экспортируются публичной точкой входа `core`.

```ts
import type {
  DocumentId, SessionId, OperationId, StorageRevision, Revision,
  DocumentFormat, StorageRef, DocumentSnapshot, EditState,
  EditTransaction, SourceSelection, ModelError, Result,
} from './spec-document-model';

export interface PortError {
  readonly code: 'invalid-input' | 'not-found' | 'permission-denied'
    | 'encoding-error' | 'io-error' | 'busy' | 'cancelled'
    | 'unsupported' | 'target-required';
  readonly message: string;
  readonly retryable: boolean;
}

export interface LoadedDocument {
  readonly documentId: DocumentId;
  readonly format: DocumentFormat;
  readonly ref: StorageRef;
  readonly snapshot: DocumentSnapshot;
  readonly storageRevision: StorageRevision;
}

export interface SaveTarget {
  readonly ref: StorageRef;
  readonly expectedRevision: StorageRevision | null;
}

export interface LeaseHandle {
  readonly token: string;
  readonly expiresAt: number;
}

export interface SaveRequest {
  readonly operationId: OperationId;
  readonly documentId: DocumentId;
  readonly format: DocumentFormat;
  readonly target: SaveTarget;
  readonly snapshot: DocumentSnapshot;
  readonly access: LeaseHandle | null;
}

export interface SaveReceipt {
  readonly operationId: OperationId;
  readonly documentId: DocumentId;
  readonly format: DocumentFormat;
  readonly ref: StorageRef;
  readonly storageRevision: StorageRevision;
  readonly versionId: string | null;
}

export type CommitOutcome =
  | { readonly kind: 'saved'; readonly receipt: SaveReceipt }
  | { readonly kind: 'history-pending'; readonly receipt: SaveReceipt;
      readonly error: PortError }
  | { readonly kind: 'conflict'; readonly actualRevision: StorageRevision | null }
  | { readonly kind: 'not-written'; readonly error: PortError };

export type SaveResult = CommitOutcome
  | { readonly kind: 'unknown'; readonly operationId: OperationId;
      readonly error: PortError };

export type OperationStatus =
  | { readonly kind: 'pending' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'settled'; readonly outcome: CommitOutcome };

export interface DocumentStore {
  load(ref: StorageRef, access: LeaseHandle | null): Promise<Result<LoadedDocument, PortError>>;
  save(request: SaveRequest): Promise<SaveResult>;
  getOperation(operationId: OperationId): Promise<Result<OperationStatus, PortError>>;
  reconcile(operationId: OperationId): Promise<SaveResult>;
}

export interface VersionSummary {
  readonly id: string;
  readonly savedAt: number;
}

export interface HistoryStore {
  list(ref: StorageRef, access: LeaseHandle | null): Promise<Result<readonly VersionSummary[], PortError>>;
  read(ref: StorageRef, versionId: string, access: LeaseHandle | null): Promise<Result<DocumentSnapshot, PortError>>;
}

export interface DraftKey {
  readonly documentId: DocumentId;
  readonly sessionId: SessionId;
}

export interface DraftRecord {
  readonly key: DraftKey;
  readonly format: DocumentFormat;
  readonly location: StorageRef | null;
  readonly snapshot: DocumentSnapshot;
  readonly baseline: DocumentSnapshot;
  readonly baseStorageRevision: StorageRevision | null;
  readonly stateRevision: Revision;
}

export interface DraftStore {
  put(draft: DraftRecord): Promise<Result<{ readonly accepted: boolean }, PortError>>;
  list(): Promise<Result<readonly DraftRecord[], PortError>>;
  removeThrough(key: DraftKey, stateRevision: Revision): Promise<Result<void, PortError>>;
}

export interface AssetPayload {
  readonly fileName: string;
  readonly mimeType: string;
  readonly base64: string;
}

export interface AssetStore {
  add(owner: StorageRef, asset: AssetPayload, access: LeaseHandle | null): Promise<Result<{ readonly relativeUrl: string }, PortError>>;
  resolve(owner: StorageRef, relativeUrl: string, access: LeaseHandle | null): Promise<Result<AssetPayload, PortError>>;
}

export interface AccessLease {
  acquire(ref: StorageRef): Promise<Result<LeaseHandle, PortError>>;
  renew(ref: StorageRef, handle: LeaseHandle): Promise<Result<LeaseHandle, PortError>>;
  release(ref: StorageRef, handle: LeaseHandle): Promise<Result<void, PortError>>;
}

export interface ResourceEvent {
  readonly ref: StorageRef;
  readonly kind: 'changed' | 'deleted';
}

export interface ResourceEvents {
  watch(ref: StorageRef, listener: (event: ResourceEvent) => void, onError: (error: PortError) => void): () => void;
}

export interface StorageServices {
  readonly id: string;
  readonly documents: DocumentStore;
  readonly history: HistoryStore;
  readonly drafts: DraftStore;
  readonly assets: AssetStore | null;
  readonly events: ResourceEvents | null;
  readonly access: AccessLease | null;
}

export interface SaveAttempt {
  readonly request: SaveRequest;
  readonly capturedStateRevision: Revision;
}

export type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving'; readonly attempt: SaveAttempt }
  | { readonly kind: 'failed'; readonly attempt: SaveAttempt; readonly error: PortError }
  | { readonly kind: 'history-pending'; readonly attempt: SaveAttempt;
      readonly receipt: SaveReceipt; readonly error: PortError }
  | { readonly kind: 'unknown'; readonly attempt: SaveAttempt; readonly error: PortError };

export type ConflictState =
  | { readonly kind: 'none' }
  | { readonly kind: 'changed'; readonly observed: LoadedDocument | null }
  | { readonly kind: 'deleted' };

export interface SessionView {
  readonly sessionId: SessionId;
  readonly edit: EditState;
  readonly baseline: DocumentSnapshot;
  readonly storageRevision: StorageRevision | null;
  readonly isDirty: boolean;
  readonly save: SaveState;
  readonly conflict: ConflictState;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly draftError: PortError | null;
}

export interface CommandReply {
  readonly view: SessionView;
  readonly selection: SourceSelection;
}

export type CommandError = ModelError | PortError;

export interface DocumentApplication {
  create(format: DocumentFormat): SessionId;
  open(ref: StorageRef): Promise<Result<SessionId, PortError>>;
  getSnapshot(sessionId: SessionId): SessionView | undefined;
  subscribe(sessionId: SessionId, listener: () => void): () => void;
  apply(sessionId: SessionId, transaction: EditTransaction): Result<CommandReply, CommandError>;
  undo(sessionId: SessionId): Result<CommandReply, CommandError>;
  redo(sessionId: SessionId): Result<CommandReply, CommandError>;
  setSelection(sessionId: SessionId, selection: SourceSelection): Result<void, CommandError>;
  breakUndoGroup(sessionId: SessionId): Result<void, PortError>;
  save(sessionId: SessionId, target?: SaveTarget): Promise<SaveResult>;
  reconcileSave(sessionId: SessionId): Promise<SaveResult>;
  flushDraft(sessionId: SessionId): Promise<Result<void, PortError>>;
  reload(sessionId: SessionId, intent: 'if-clean' | 'discard-local'): Promise<Result<void, PortError>>;
  close(sessionId: SessionId, decision: 'cancel' | 'discard' | 'save', target?: SaveTarget): Promise<Result<{ readonly closed: boolean }, PortError>>;
}

export interface DesktopDialogs {
  pickOpen(): Promise<Result<readonly StorageRef[] | null, PortError>>;
  pickSave(input: {
    readonly suggestedName: string;
    readonly format: DocumentFormat;
    readonly current: StorageRef | null;
  }): Promise<Result<SaveTarget | null, PortError>>;
}

export interface IpcEntry<Request, Response> {
  readonly request: Request;
  readonly response: Response;
}

export interface DesktopIpcMap {
  'app:info': IpcEntry<null, Result<{ readonly appVersion: string }, PortError>>;
  'storage:health': IpcEntry<null, Result<{ readonly schemaVersion: number }, PortError>>;
  'dialog:open': IpcEntry<null, Awaited<ReturnType<DesktopDialogs['pickOpen']>>>;
  'dialog:save': IpcEntry<Parameters<DesktopDialogs['pickSave']>[0], Awaited<ReturnType<DesktopDialogs['pickSave']>>>;
  'document:load': IpcEntry<{ readonly ref: StorageRef }, Result<LoadedDocument, PortError>>;
  'document:save': IpcEntry<SaveRequest, SaveResult>;
  'operation:get': IpcEntry<{ readonly operationId: OperationId }, Result<OperationStatus, PortError>>;
  'operation:reconcile': IpcEntry<{ readonly operationId: OperationId }, SaveResult>;
  'history:list': IpcEntry<{ readonly ref: StorageRef }, Result<readonly VersionSummary[], PortError>>;
  'history:read': IpcEntry<{ readonly ref: StorageRef; readonly versionId: string }, Result<DocumentSnapshot, PortError>>;
  'draft:put': IpcEntry<DraftRecord, Result<{ readonly accepted: boolean }, PortError>>;
  'draft:list': IpcEntry<null, Result<readonly DraftRecord[], PortError>>;
  'draft:remove': IpcEntry<{ readonly key: DraftKey; readonly through: Revision }, Result<null, PortError>>;
  'resource:watch': IpcEntry<{ readonly ref: StorageRef }, Result<{ readonly subscriptionId: string }, PortError>>;
  'resource:unwatch': IpcEntry<{ readonly subscriptionId: string }, Result<null, PortError>>;
  'asset:add': IpcEntry<{ readonly owner: StorageRef; readonly payload: AssetPayload }, Result<{ readonly relativeUrl: string }, PortError>>;
  'asset:resolve': IpcEntry<{ readonly owner: StorageRef; readonly relativeUrl: string }, Result<AssetPayload, PortError>>;
}

export interface DesktopEventMap {
  'resource:changed': { readonly subscriptionId: string; readonly event: ResourceEvent };
  'app:open-files': { readonly refs: readonly StorageRef[] };
}
```

## 3. Семантика хранения

- `load` возвращает согласованный снимок вместе с его ревизией. При ошибке кодирования или чтения частичный документ не возвращается.
- `expectedRevision: null` означает «ресурс должен отсутствовать», а не безусловную перезапись. Для перезаписи существующего файла диалог подтверждает выбор и возвращает фактическую ревизию; перед записью она проверяется ещё раз.
- `save` фиксирует точный снимок. Неявная нормализация или замена непредставимых символов недопустимы.
- Локальный адаптер P4 регистрирует начальную версию существующего файла при первом успешном load; перед подтверждённой перезаписью сохраняет прежнее состояние цели. История принадлежит resourceId, Save As не копирует историю старой цели и сохраняет DocumentId рабочей сессии. Семантика seed memory-стенда не заменяет эту политику.
- `saved` включает запись содержимого и завершённую политику истории. `versionId: null` допустим, если новой версии не возникло, например сохранённое состояние не изменилось.
- `history-pending` подтверждает запись содержимого, но не завершение истории. Результат содержит новую ревизию файла.
- До завершения истории receipt.versionId может быть null: новая версия ещё не подтверждена. Последующий saved возвращает фактический ID; operationId, документ, цель и подтверждённый снимок при этом не меняются.
- `conflict.actualRevision: null` означает отсутствие ресурса. Для сравнения приложение отдельно загружает доступное актуальное содержимое.
- `not-written` разрешён только при известном отсутствии записи. Потеря транспорта или неопределённое исключение после начала операции дают `unknown`.
- Повтор одинакового запроса с тем же `operationId` возвращает прежний результат или продолжает незавершённую операцию. Тот же ID с другим содержимым/целью даёт `invalid-input`.
- `getOperation` только читает состояние; `reconcile` пытается завершить журнал или выяснить исход записи. `missing` не даёт права на безусловную перезапись: повтор исходного запроса сохраняет исходные ID и expectedRevision.
- Ожидаемые ошибки возвращаются как данные. Неожиданное исключение обрабатывается на границе адаптера с сохранением различия «не записано»/«исход неизвестен».

`HistoryStore.list` возвращает версии от новой к старой. `read` не меняет документ. Восстановление — применение полученного снимка к сессии; новое сохранение выполняется обычным путём.

`DraftStore.put` принимает только более новую `stateRevision` в пределах ключа document/session. Сначала проверяется граница очистки: ревизия до неё включительно возвращает `accepted: false`, даже при повторе ранее принятой записи. Выше границы равная ревизия с тем же полным record идемпотентна; с другим payload — `invalid-input`. Более старая возвращает `accepted: false`. Приложение фиксирует неизменяемый DraftRecord для ревизии при изменении сохраняемого состояния; повтор отправляет этот же record. Подтверждение save не переписывает baseline уже отправленного record той же ревизии. `removeThrough` сохраняет монотонно возрастающую границу очистки, защищая от запоздавших put. Переоткрытая сессия получает новый ключ.

`AssetStore` использует base64 для небольших изображений первой версии: это простой сериализуемый контракт. Адаптер проверяет формат данных, создаёт уникальное имя и возвращает относительную ссылку. Разрешение ссылки ограничено ресурсами документа. Физические операции и сценарий нового несохранённого документа детализируются в P6.

## 4. Семантика приложения

- `create` создаёт пустую сессию без ввода/вывода. ID и часы предоставляются при сборке зависимостей, что позволяет воспроизводимые проверки.
- `open` загружает документ, а для хранилища с арендой сначала получает доступ. При неуспешной загрузке полученная аренда освобождается. Внутри одного окна повторное открытие того же ресурса возвращает существующую сессию.
- `getSnapshot` возвращает неизменяемый объект, сохраняющий ссылочную идентичность до следующего изменения сессии. Это контракт для React `useSyncExternalStore`.
- `subscribe` вызывается после фиксации целостного состояния; функция отписки идемпотентна. Уведомление не вызывает новую правку.
- `apply`, `undo`, `redo` синхронны. Неизвестная сессия даёт `not-found`; неподходящая ревизия — ошибку модели. Выделение возвращается отдельно от документного состояния.
- `save` без target использует location и последнюю известную ревизию. Для нового документа возвращает `not-written/target-required`, после чего UI получает цель через диалог и повторяет сценарий.
- Перед save, сменой режима или закрытием UI завершает композицию активного редактора через `flush` из контракта редакторов. Данные сохраняются после подтверждённого применения композиции.
- `save` при активной записи объединяет повторные намерения в одно следующее сохранение; вызовы ожидают результат записи соответствующего следующего снимка. При частичном или неизвестном исходе новые записи приостанавливаются до `reconcileSave`.
- `reload('if-clean')` не отбрасывает правки. `discard-local` вызывается только после явного выбора пользователя. В обоих случаях запоздавший результат проверяется по session/stateRevision и номеру чтения.
- `close('cancel')` возвращает `closed: false`. `discard` очищает черновик через текущую ревизию и закрывает сессию; при ошибке очистки сессия остаётся открытой. `save` закрывает только после `saved`, если текущий снимок совпадает с подтверждённым и нет конфликта. Если во время ожидания появились новые правки, возвращается `closed: false`: они остаются в открытой сессии. На время окончательной очистки черновика и закрытия новые изменения сессии блокируются. Незавершённая/неизвестная операция даёт `busy`; её сначала разрешают.
- Отмена диалога — успешный результат с `null`, а не ошибка и не изменение состояния.

Состояния конфликта и сохранения независимы. Например, ошибка записи не снимает ранее обнаруженный внешний конфликт. Разрешение конфликта требует явного выбора нового базового состояния или цели записи.

### 4.1. Детали реализации P2 (2026-11-24)

- Фабрика приложения получает `StorageServices`, генератор ID и часы; P2 обслуживает один локальный адаптер без аренды. Неподходящий storageId и облачный адаптер с access возвращают `unsupported`. Реальные IPC/файлы и наблюдатель подключаются в P4/P5; в P2 перечитывание запускается явным `reload`.
- `setSelection` обновляет выделение вне SessionView и завершает группу при перемещении; `breakUndoGroup` вызывается при смене режима. Они не меняют ревизии, dirty и историю сохранений. Обычные транзакции группируются только при равных groupId, совпадении предыдущего selectionAfter с новым selectionBefore и интервале 0–500 мс. Ошибочная/пустая правка не очищает redo.
- Одновременные open одного ресурса разделяют одну загрузку. Сохранение в ресурс другой открытой/сохраняющейся сессии отклоняется как `busy`; незавершённая цель записи резервируется до известного исхода. ID документа при смене цели в P2 остаётся прежним; локальная идентичность детализируется в P4.
- Следующее намерение save объединяет ожидающих; последний явно переданный target заменяет предыдущий, отсутствие target его не стирает. Снимок фиксируется при старте. После `saved` очередь продолжается; после ошибки/конфликта ожидающие получают этот результат без автоматического повторения; после `unknown`/`history-pending` ждут reconcile. `getOperation: missing` повторяет исходный неизменяемый запрос с тем же ID и expectedRevision.
- Если ожидающий target совпадает с только что записанной целью и содержит прежнюю expectedRevision этой же операции, приложение заменяет её подтверждённой ревизией собственной записи. Иначе повторное сохранение нового документа ошибочно конфликтовало бы с самим собой. Другая ожидаемая ревизия не подменяется; проверка адаптера остаётся обязательной. Конфликт альтернативной цели возвращается вызывающей команде как SaveResult и не отмечает исходный открытый ресурс изменённым извне.
- Исключение/некорректное подтверждение после вызова save означает `unknown`, а не «не записано». Receipt проверяется по operationId, documentId, формату и цели. Подтверждённый снимок становится baseline, но не рабочим текстом. Save в известный конфликт того же ресурса запрещён до явного reload или выбора другой цели; успешная запись в другую цель снимает конфликт старого ресурса.
- Ошибка очистки черновика не превращает подтверждённую запись файла в ошибку записи: доступна отдельно через `draftError`. Очистка ограничена capturedStateRevision. Закрытие повторяет очистку и при её ошибке оставляет сессию открытой. Flush чистой сессии удаляет уже ненужные черновики условно через текущую ревизию.
- Любое асинхронное чтение проверяет живую сессию, номер запроса, stateRevision и поколение операций сохранения. Даже явный discard-local не отбрасывает ввод, появившийся после начала чтения. Запоздалые ответы после закрытия не уведомляют новую сессию. `close` блокирует правки только на окончательной очистке; правки во время ожидания save сохраняют открытую вкладку.
- Тестовый адаптер в `tests/support` реализует DocumentStore/HistoryStore/DraftStore в памяти, пять версий и tombstone-очистку. Исходное seed-состояние не создаёт версию; это условие тестового стенда, а не решение о первой версии существующего файла (P4). Сбойные исходы и задержки задаются обёртками портов в тестах, без тестовых переключателей production-кода.

## 5. IPC и валидация

P1 реализует `app:info` и `storage:health` для запуска и проверки нативной SQLite. Остальные обработчики вводятся вместе с модулями P4–P7. Диагностические операции возвращают сведения приложения/схемы, а не принимают произвольный SQL.

Preload предоставляет фиксированные методы, соответствующие таблице каналов; renderer не получает универсальный `send(channel, payload)`. Каждый аргумент проходит runtime-проверку в main: строки ID, целые ревизии, структура снимка и разрешённые ссылки на ресурсы. TypeScript не заменяет проверку входных данных.

Main связывает выданные ресурсы и подписки с отправителем. Renderer не передаёт произвольный файловый путь вместо разрешённого `StorageRef`. `app:open-files` доставляет ресурсы из диалога, ассоциации файлов или повторного запуска; событие при старте доставляется после готовности renderer.

Транспорт передаёт объекты, массивы, строки, числа, boolean и null. Внутренний `Result<void, E>` превращается на IPC-границе в `Result<null, E>`, как указано в карте каналов; отсутствие значения не используется как признак ошибки. Исключения/прототипы классов, DOM и объекты редактора не пересылаются.

`ResourceEvents.watch` в renderer создаёт подписку через request/response, затем фильтрует события по ID. Возвращаемая отписка отменяет также регистрацию, если ответ ещё не пришёл; уничтожение renderer освобождает все его подписки в main. Ошибки регистрации передаются через `onError`; проверка ревизии при save обязательна и без наблюдателя.

## 6. Проверка контрактов

| ID | Проверка |
| --- | --- |
| MC-01 | Чистая реализация в памяти и локальная реализация проходят один набор load/save-проверок |
| MC-02 | Null expectedRevision не перезаписывает существующий ресурс |
| MC-03 | Повтор operationId не создаёт вторую версию; другой payload с тем же ID отклоняется |
| MC-04 | Ошибки до записи, после записи файла и потеря ответа дают разные результаты |
| MC-05 | Запоздалый put после removeThrough не воскрешает удалённый черновик |
| MC-06 | Отмена диалога не создаёт ресурс, историю или изменение сессии |
| MC-07 | Снимок подписки стабилен до изменения; отписка освобождает слушателей |
| MC-08 | Runtime-валидация отклоняет неподходящие DTO и чужой/невыданный resourceId |
| MC-09 | Отписка до подтверждения watch и закрытие renderer не оставляют подписку в main |

Типы `AccessLease` обозначают границу будущего облачного модуля. Аутентификация, HTTP-endpoints и параметры аренды относятся ко второй версии; локальная реализация использует `access: null`.
