export type * from './storage';

export interface PortError {
  readonly code:
    | 'invalid-input'
    | 'not-found'
    | 'permission-denied'
    | 'encoding-error'
    | 'io-error'
    | 'busy'
    | 'cancelled'
    | 'unsupported'
    | 'target-required';
  readonly message: string;
  readonly retryable: boolean;
}
