import { MemoryRoomStore } from './memory-room-store';
import { describeRoomStore } from './room-store.contract';

describeRoomStore('memória', (now, opts) => new MemoryRoomStore(now, opts));
