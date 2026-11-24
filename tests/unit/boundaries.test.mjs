import { describe, expect, it } from 'vitest';
import { boundaryError, checkBoundaries, sourceImports } from '../../scripts/check-boundaries.mjs';

describe('границы модулей', () => {
  it('принимает публичные импорты и текущий граф', () => {
    expect(boundaryError('application/session.ts', 'core/index.ts', '../../core')).toBeNull();
    expect(checkBoundaries()).toEqual([]);
  });
  it('запрещает обратные зависимости и обход index', () => {
    expect(boundaryError('core/model.ts', 'ui/index.ts', '../ui')).toBeTruthy();
    expect(boundaryError('application/session.ts', 'core/model.ts', '../core/model')).toBeTruthy();
    expect(
      boundaryError('ui/view.tsx', 'platform/desktop/shared/contracts.ts', '../platform'),
    ).toBeTruthy();
  });
  it.each([
    'node:fs',
    'fs/promises',
    'react',
    'react/jsx-runtime',
    'electron',
    'better-sqlite3',
    'express',
  ])('запрещает %s в чистой логике', (name) => {
    expect(boundaryError('core/model.ts', null, name)).toBeTruthy();
  });
  it('находит статические, type-, динамические импорты, re-export и require', () => {
    expect(
      sourceImports(
        `import type { X } from './a'; export * from './b'; import('./c'); require('node:fs'); import(variable); type T = import('./d').T;`,
        'sample.ts',
      ),
    ).toEqual(['./a', './b', './c', 'node:fs', null, './d']);
  });
});
