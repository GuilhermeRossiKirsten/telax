import { MemoryRoomStore } from './memory-room-store';
import type { RoomStore } from './room-store';

const globalForStore = globalThis as unknown as { __telaxStore?: RoomStore };

/** Singleton em globalThis para sobreviver a hot reload; um por instância do servidor. */
export function getStore(): RoomStore {
  globalForStore.__telaxStore ??= new MemoryRoomStore();
  return globalForStore.__telaxStore;
}
