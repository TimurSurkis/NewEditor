// Совместимость читающего подэтапа P4.2. Новые подключения используют полную фабрику.
export { createLocalServices as createLocalReadServices } from './local-services';
export type {
  LocalClient as LocalReadClient,
  LocalServices as LocalReadServices,
  LocalOptions as LocalReadOptions,
} from './local-services';
