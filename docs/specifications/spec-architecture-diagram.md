# Упрощённая диаграмма архитектуры

Десктопная версия. Схема кратко отражает [архитектурную спецификацию](spec-architecture.md), не вводя новых решений.

```mermaid
flowchart TB
    subgraph Renderer["Renderer — интерфейс и рабочая сессия"]
        UI["React + редакторы<br/>CodeMirror / ProseMirror"]
        App["Сценарии приложения"]
        Model["Модель документа + Markdown<br/>исходный текст, правки, undo/redo"]

        UI --> App
        App --> Model
    end

    App --> Bridge["Порты → ограниченный preload / IPC"]

    subgraph Main["Main — доступ к локальным данным"]
        Storage["Сервисы хранения"]
    end

    Bridge --> Storage
    Storage --> Files["Обычные файлы TXT / Markdown"]
    Storage --> DB[("SQLite<br/>история и черновики")]
```

**Главный принцип:** исходный текст — основа документа; оба редактора используют одну сессию и общую историю правок.
