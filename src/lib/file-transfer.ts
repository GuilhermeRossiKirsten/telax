export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const CHUNK_SIZE = 16 * 1024;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;

export type FileHeader = { id: string; name: string; size: number; mime: string };

/** Um envio por vez em cada canal: mensagens de arquivos diferentes nunca se intercalam. */
const queues = new WeakMap<RTCDataChannel, Promise<unknown>>();

export function sendFile(
  channel: RTCDataChannel,
  file: File,
  onProgress?: (sent: number) => void,
): Promise<void> {
  if (file.size > MAX_FILE_BYTES) return Promise.reject(new Error('file_too_large'));
  const previous = queues.get(channel) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => transfer(channel, file, onProgress));
  queues.set(channel, run);
  return run;
}

async function transfer(channel: RTCDataChannel, file: File, onProgress?: (sent: number) => void) {
  if (channel.readyState !== 'open') throw new Error('channel_closed');
  channel.bufferedAmountLowThreshold = LOW_WATER;
  const header: FileHeader = { id: crypto.randomUUID(), name: file.name, size: file.size, mime: file.type };
  channel.send(JSON.stringify({ type: 'file-start', header }));
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    if (channel.bufferedAmount > HIGH_WATER) await drained(channel);
    const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
    channel.send(chunk);
    onProgress?.(Math.min(offset + CHUNK_SIZE, file.size));
  }
  channel.send(JSON.stringify({ type: 'file-end', id: header.id }));
}

function drained(channel: RTCDataChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      channel.removeEventListener('bufferedamountlow', onLow);
      channel.removeEventListener('close', onClose);
      channel.removeEventListener('error', onClose);
    };
    const onLow = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('channel_closed'));
    };
    channel.addEventListener('bufferedamountlow', onLow);
    channel.addEventListener('close', onClose);
    channel.addEventListener('error', onClose);
  });
}

type Incoming = { header: FileHeader; chunks: ArrayBuffer[]; received: number; broken: boolean };

function parseHeader(h: unknown): FileHeader | null {
  if (!h || typeof h !== 'object') return null;
  const { id, name, size, mime } = h as Record<string, unknown>;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof mime !== 'string') return null;
  if (typeof size !== 'number' || !(size >= 0) || size > MAX_FILE_BYTES) return null;
  return { id, name, size, mime };
}

export class FileAssembler {
  private current: Incoming | null = null;

  constructor(
    private onDone: (file: { header: FileHeader; blob: Blob }) => void,
    private onProgress?: (id: string, received: number, total: number) => void,
  ) {}

  handle(data: string | ArrayBuffer): void {
    if (typeof data !== 'string') return this.chunk(data);
    let msg: { type?: unknown; header?: unknown; id?: unknown };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'file-start') {
      const header = parseHeader(msg.header);
      this.current = header ? { header, chunks: [], received: 0, broken: false } : null;
    } else if (msg.type === 'file-end') {
      this.finish(msg.id);
    }
  }

  private chunk(data: ArrayBuffer) {
    const cur = this.current;
    if (!cur || cur.broken) return;
    cur.received += data.byteLength;
    if (cur.received > cur.header.size) {
      cur.broken = true;
      cur.chunks = [];
      return;
    }
    cur.chunks.push(data);
    this.onProgress?.(cur.header.id, cur.received, cur.header.size);
  }

  private finish(id: unknown) {
    const cur = this.current;
    this.current = null;
    if (!cur || cur.broken || cur.header.id !== id || cur.received !== cur.header.size) return;
    this.onDone({ header: cur.header, blob: new Blob(cur.chunks, { type: cur.header.mime }) });
  }
}
