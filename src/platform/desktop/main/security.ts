import { pathToFileURL } from 'node:url';
import type { PortError } from '../../../ports';

export function rendererUrl(
  devUrl: string | undefined,
  packaged: boolean,
  htmlPath: string,
): string {
  if (!packaged && devUrl) {
    const url = new URL(devUrl);
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password
    ) {
      throw new Error('Dev renderer должен использовать локальный HTTP-сервер');
    }
    return url.href;
  }
  return pathToFileURL(htmlPath).href;
}

export function validateDiagnosticRequest(
  senderIsTrusted: boolean,
  frameIsMain: boolean,
  frameUrl: string | undefined,
  expectedUrl: string,
  args: readonly unknown[],
): PortError | null {
  const source = validateRequestSource(senderIsTrusted, frameIsMain, frameUrl, expectedUrl);
  if (source) return source;
  if (args.length !== 1 || args[0] !== null) {
    return { code: 'invalid-input', message: 'Ожидается пустой запрос', retryable: false };
  }
  return null;
}

export function validateRequestSource(
  senderIsTrusted: boolean,
  frameIsMain: boolean,
  frameUrl: string | undefined,
  expectedUrl: string,
): PortError | null {
  if (!senderIsTrusted || !frameIsMain || frameUrl !== expectedUrl) {
    return { code: 'permission-denied', message: 'Источник запроса не разрешён', retryable: false };
  }
  return null;
}
