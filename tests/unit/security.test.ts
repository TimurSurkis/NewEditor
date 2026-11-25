import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  rendererUrl,
  validateDiagnosticRequest,
  validateRequestSource,
} from '../../src/platform/desktop/main/security';

describe('IPC и источник renderer', () => {
  const url = 'http://127.0.0.1:5173/';
  it('принимает только null от главного frame доверенного окна', () => {
    expect(validateDiagnosticRequest(true, true, url, url, [null])).toBeNull();
    for (const args of [[], [{}], [undefined], [null, null], ['SQL']]) {
      expect(validateDiagnosticRequest(true, true, url, url, args)?.code).toBe('invalid-input');
    }
  });
  it('отклоняет другое окно, subframe, изменённый URL и отсутствующий frame', () => {
    expect(validateDiagnosticRequest(false, true, url, url, [null])?.code).toBe(
      'permission-denied',
    );
    expect(validateDiagnosticRequest(true, false, url, url, [null])?.code).toBe(
      'permission-denied',
    );
    expect(validateDiagnosticRequest(true, true, `${url}other`, url, [null])?.code).toBe(
      'permission-denied',
    );
    expect(validateDiagnosticRequest(true, true, undefined, url, [null])?.code).toBe(
      'permission-denied',
    );
  });
  it('не разрешает удалённый dev-сервер и credentials', () => {
    const htmlPath = resolve('app/index.html');
    expect(rendererUrl(url, false, '/app/index.html')).toBe(url);
    expect(() => rendererUrl('https://example.org', false, '/app/index.html')).toThrow();
    expect(() => rendererUrl('http://user@localhost', false, '/app/index.html')).toThrow();
    expect(rendererUrl('https://example.org', true, htmlPath)).toBe(pathToFileURL(htmlPath).href);
    expect(rendererUrl(undefined, false, resolve('app/документ с пробелом.html'))).toContain('%20');
  });
  it('общая файловая граница не принимает subframe даже с доверенным URL и WebContents', () => {
    expect(validateRequestSource(true, false, url, url)?.code).toBe('permission-denied');
    expect(validateRequestSource(true, true, url, url)).toBeNull();
  });
});
