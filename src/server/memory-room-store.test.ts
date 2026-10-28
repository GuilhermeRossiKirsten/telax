import { MemoryRoomStore } from './memory-room-store';
import { describeRoomStore } from './room-store.contract';

describeRoomStore('memória', (now) => new MemoryRoomStore(now));
