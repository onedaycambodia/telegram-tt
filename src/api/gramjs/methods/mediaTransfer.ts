import { Api as GramJs } from '../../../lib/gramjs';
import { generateRandomBigInt } from '../../../lib/gramjs/Helpers';

import type { ApiChat } from '../../types';

import { buildInputPeer } from '../gramjsBuilders';
import * as clientModule from './client';

const { invokeRequest } = clientModule;

/**
 * All Media Transfer - worker side (GramJS).
 * Runs inside the API worker.
 *
 * Supports:
 * - Progress tracking
 * - Cancel
 * - Skip previously transferred IDs
 * - Text, photos and videos
 * - Album planning
 * - Caption hiding
 * - Forward without original author
 * - Download mode: download every file, then upload it again (works for protected / no-forward chats)
 * - FLOOD_WAIT handling for EVERY step (history, forward, download, upload, send)
 */

export type MediaTransferKind = 'video' | 'photo' | 'text';

export type MediaTransferTypes = Record<MediaTransferKind, boolean>;

export type MediaTransferStatus = {
  status: 'preparing' | 'running' | 'done' | 'cancelled' | 'error';
  collected: number;
  total: number;
  done: number;
  failed: number;
  tot: Partial<Record<MediaTransferKind, number>>;
  cnt: Partial<Record<MediaTransferKind, number>>;
  error?: string;
  copying?: boolean;
  sentIds: number[];
  /** Short live text for the progress window, e.g. "Telegram FloodWait - resuming in 42s" */
  note?: string;
  /** true when the job downloads + re-uploads instead of forwarding */
  download?: boolean;
};

type Job = MediaTransferStatus & {
  cancel: boolean;
};

type Item = {
  m: GramJs.Message;
  kind: MediaTransferKind;
  album: boolean;
};

type Unit = {
  album: boolean;
  items: Item[];
};

export type StartMediaTransferParams = {
  jobId: string;
  fromChat: ApiChat;
  toChat: ApiChat;
  types: MediaTransferTypes;
  hideCaption: boolean;
  albums: boolean;
  skipIds: number[];
  /** NEW: download each file and upload it again instead of forwarding */
  download?: boolean;
};

const jobs = new Map<string, Job>();

const ALBUM_MIN = 5;
const ALBUM_MAX = 6;
const FORWARD_BATCH = 100;
const PAUSE_MS = 400;
const DOWNLOAD_PAUSE_MS = 1500; // pause between sends in download mode (avoids FloodWait)

const FLOOD_TRIES = 20; // floods in a row before an item finally fails
const FLOOD_MAX_S = 3700; // longest single flood we wait out
const NET_TRIES = 6; // connection problems in a row before an item fails
const STALL_MS = 10 * 60 * 1000; // a download / upload that moves no data for this long is cancelled and retried

const FATAL = [
  'CHAT_WRITE_FORBIDDEN',
  'CHAT_ADMIN_REQUIRED',
  'USER_BANNED_IN_CHANNEL',
  'PEER_ID_INVALID',
  'CHANNEL_PRIVATE',
  'CHAT_SEND_PHOTOS_FORBIDDEN',
  'CHAT_SEND_MEDIA_FORBIDDEN',
];

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const albumSize = () =>
  ALBUM_MIN + Math.floor(Math.random() * (ALBUM_MAX - ALBUM_MIN + 1));

const errText = (err: unknown) =>
  String((err as any)?.message || (err as any)?.errorMessage || err);

/* ------------------------------------------------------------------------------------------ */
/* Job controls */

export function startMediaTransfer(params: StartMediaTransferParams) {
  const job: Job = {
    status: 'preparing',
    collected: 0,
    total: 0,
    done: 0,
    failed: 0,
    tot: {},
    cnt: {},
    sentIds: [],
    cancel: false,
    download: Boolean(params.download),
  };

  jobs.set(params.jobId, job);

  void run(job, params);

  return { jobId: params.jobId };
}

export function getMediaTransferStatus(
  jobId: string,
): MediaTransferStatus | undefined {
  const job = jobs.get(jobId);

  if (!job) return undefined;

  const { cancel, ...snapshot } = job;

  const result: MediaTransferStatus = {
    ...snapshot,
    tot: { ...job.tot },
    cnt: { ...job.cnt },
    sentIds: [...job.sentIds],
  };

  job.sentIds = [];

  return result;
}

export function cancelMediaTransfer(jobId: string) {
  const job = jobs.get(jobId);

  if (job) {
    job.cancel = true;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Classification */

function classify(
  m: GramJs.Message,
): { kind?: MediaTransferKind; album: boolean } {
  const media = m.media;

  if (
    !media ||
    media instanceof GramJs.MessageMediaEmpty ||
    media instanceof GramJs.MessageMediaWebPage
  ) {
    return {
      kind: m.message ? 'text' : undefined,
      album: false,
    };
  }

  if (media instanceof GramJs.MessageMediaPhoto) {
    if (!(media.photo instanceof GramJs.Photo) || media.ttlSeconds) {
      return { album: false };
    }

    return {
      kind: 'photo',
      album: true,
    };
  }

  if (media instanceof GramJs.MessageMediaDocument) {
    const doc = media.document;

    if (!(doc instanceof GramJs.Document) || media.ttlSeconds) {
      return { album: false };
    }

    const video = doc.attributes.find(
      (a) => a instanceof GramJs.DocumentAttributeVideo,
    ) as GramJs.DocumentAttributeVideo | undefined;

    const isGif = doc.attributes.some(
      (a) => a instanceof GramJs.DocumentAttributeAnimated,
    );

    const isSticker = doc.attributes.some(
      (a) => a instanceof GramJs.DocumentAttributeSticker,
    );

    if (!video || isGif || isSticker || video.roundMessage) {
      return { album: false };
    }

    return {
      kind: 'video',
      album: doc.mimeType !== 'video/webm',
    };
  }

  return { album: false };
}

/* ------------------------------------------------------------------------------------------ */
/* FloodWait + retry (used by EVERY step: history, forward, download, upload, send) */

function floodSeconds(err: unknown): number {
  const direct = Number((err as any)?.seconds);

  if (direct > 0) return direct;

  const match = errText(err).match(
    /FLOOD_WAIT_?(\d+)|SLOWMODE_WAIT_?(\d+)|wait of (\d+) seconds/i,
  );

  return match ? Number(match[1] || match[2] || match[3]) : 0;
}

function isTransient(err: unknown) {
  return /timeout|timed out|stalled|connection|socket|network|disconnect|closed|ECONN|EPIPE|Not connected/i
    .test(errText(err));
}

/** Waits the WHOLE flood (+1 s), updates `job.note` every second as a countdown, stops early on cancel. */
async function waitFlood(job: Job, seconds: number) {
  const end = Date.now() + (Math.min(seconds, FLOOD_MAX_S) + 1) * 1000;

  while (!job.cancel) {
    const left = end - Date.now();

    if (left <= 0) break;

    job.note = `Telegram FloodWait - resuming in ${Math.ceil(left / 1000)}s`;

    await sleep(Math.min(left, 1000));
  }

  job.note = undefined;
}

/** Runs fn(); FloodWait -> wait it out and retry the SAME step; connection problem -> short backoff and retry. */
async function withRetry<T>(job: Job, fn: () => Promise<T>): Promise<T> {
  let floods = 0;
  let nets = 0;

  for (;;) {
    if (job.cancel) {
      throw new Error('CANCELLED');
    }

    try {
      return await fn();
    } catch (err) {
      if (job.cancel) {
        throw new Error('CANCELLED');
      }

      const seconds = floodSeconds(err);

      if (seconds && floods < FLOOD_TRIES) {
        floods++;
        await waitFlood(job, seconds);
        continue;
      }

      if (!seconds && isTransient(err) && nets < NET_TRIES) {
        nets++;
        await sleep(Math.min(5000 * nets, 30000));
        continue;
      }

      throw err;
    }
  }
}

/** Cancels a download / upload that moves no data for STALL_MS (or when the job is cancelled). */
function stallGuard<T>(
  job: Job,
  what: string,
  run: (beat: (...args: any[]) => void) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let last = Date.now();
    let finished = false;

    const finish = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      fn();
    };

    const timer = setInterval(() => {
      if (job.cancel) {
        finish(() => reject(new Error('CANCELLED')));
      } else if (Date.now() - last > STALL_MS) {
        finish(() => reject(new Error(`${what} stalled - no data for ${STALL_MS / 1000}s (timeout)`)));
      }
    }, 5000);

    run(() => {
      last = Date.now();
    }).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function call(job: Job, request: any): Promise<any> {
  return withRetry(job, () => invokeRequest(request, {
    shouldThrow: true,
  }));
}

function fatalOf(err: unknown) {
  const text = errText(err);

  return FATAL.find((f) => text.includes(f));
}

/* ------------------------------------------------------------------------------------------ */
/* History collection */

async function collect(job: Job, fromPeer: any) {
  const all: GramJs.Message[] = [];

  let offsetId = 0;

  while (!job.cancel) {
    const res = await call(
      job,
      new GramJs.messages.GetHistory({
        peer: fromPeer,
        offsetId,
        offsetDate: 0,
        addOffset: 0,
        limit: 100,
        maxId: 0,
        minId: 0,
        hash: BigInt(0),
      }),
    );

    const raw: any[] = res?.messages || [];

    if (!raw.length) {
      break;
    }

    raw.forEach((m) => {
      if (m instanceof GramJs.Message) {
        all.push(m);
      }
    });

    offsetId = Math.min(...raw.map((m) => m.id));

    job.collected = all.length;

    await sleep(150);
  }

  return all.sort((a, b) => a.id - b.id);
}

/* ------------------------------------------------------------------------------------------ */
/* Planning */

function plan(items: Item[], albums: boolean): Unit[] {
  const units: Unit[] = [];

  let fwd: Item[] = [];
  let carry: Item[] = [];
  let target = albumSize();

  const flushFwd = () => {
    if (fwd.length) {
      units.push({
        album: false,
        items: fwd,
      });
    }

    fwd = [];
  };

  const flushCarry = () => {
    if (carry.length >= 2) {
      flushFwd();

      units.push({
        album: true,
        items: carry,
      });
    } else {
      fwd.push(...carry);
    }

    carry = [];
    target = albumSize();
  };

  items.forEach((item) => {
    if (albums && item.album) {
      carry.push(item);

      if (carry.length >= target) {
        flushCarry();
      }

      return;
    }

    flushCarry();

    fwd.push(item);

    if (fwd.length >= FORWARD_BATCH) {
      flushFwd();
    }
  });

  flushCarry();
  flushFwd();

  return units;
}

/* ------------------------------------------------------------------------------------------ */
/* Forwarding */

async function forwardMessages(
  job: Job,
  fromPeer: any,
  toPeer: any,
  items: Item[],
  hideCaption: boolean,
) {
  if (!items.length) return;

  await call(
    job,
    new GramJs.messages.ForwardMessages({
      fromPeer,
      toPeer,
      id: items.map((i) => i.m.id),
      randomId: items.map(() => generateRandomBigInt()),
      dropAuthor: true,
      dropMediaCaptions: hideCaption || undefined,
    }),
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Download mode: download the file, upload it again, send it (waits every FloodWait) */

function getClient(): any {
  const client = (clientModule as any).getClient?.();

  if (!client) {
    throw new Error('Telegram client is not available for download mode');
  }

  return client;
}

function fileNameOf(m: GramJs.Message, kind: MediaTransferKind) {
  const media: any = m.media;
  const attrs: any[] = media?.document?.attributes || [];
  const named = attrs.find((a) => a instanceof GramJs.DocumentAttributeFilename) as any;

  if (named?.fileName) return String(named.fileName);

  return `${m.id}.${kind === 'photo' ? 'jpg' : 'mp4'}`;
}

type Prepared = {
  media: any; // InputMedia that references the file already stored on Telegram
  caption: string;
  entities?: any[];
};

/** Download -> upload -> messages.UploadMedia. Each of the 3 steps waits out FloodWait and retries by itself. */
async function prepareMedia(
  job: Job,
  toPeer: any,
  item: Item,
  hideCaption: boolean,
): Promise<Prepared> {
  const client = getClient();
  const { m, kind } = item;

  // 1) download (whole file in memory, one file at a time)
  const data: any = await withRetry(job, () => stallGuard(
    job,
    'download',
    (beat) => client.downloadMedia(m.media, { progressCallback: beat }),
  ));

  if (!data || (typeof data !== 'object')) {
    throw new Error('Could not download the file');
  }

  const name = fileNameOf(m, kind);
  const file = new File([data], name);

  // 2) upload
  const inputFile: any = await withRetry(job, () => stallGuard(
    job,
    'upload',
    (beat) => client.uploadFile({ file, onProgress: beat, workers: 1 }),
  ));

  // 3) turn the uploaded file into a reusable InputMedia
  let uploadedMedia: any;

  if (kind === 'photo') {
    uploadedMedia = new GramJs.InputMediaUploadedPhoto({ file: inputFile });
  } else {
    const doc: any = (m.media as any).document;
    const attributes = (doc.attributes as any[]).filter(
      (a) => !(a instanceof GramJs.DocumentAttributeFilename),
    );

    attributes.push(new GramJs.DocumentAttributeFilename({ fileName: name }));

    uploadedMedia = new GramJs.InputMediaUploadedDocument({
      file: inputFile,
      mimeType: doc.mimeType || 'video/mp4',
      attributes,
    });
  }

  const stored: any = await call(job, new GramJs.messages.UploadMedia({
    peer: toPeer,
    media: uploadedMedia,
  }));

  let media: any;

  if (stored?.photo instanceof GramJs.Photo) {
    const p = stored.photo;

    media = new GramJs.InputMediaPhoto({
      id: new GramJs.InputPhoto({
        id: p.id,
        accessHash: p.accessHash,
        fileReference: p.fileReference,
      }),
    });
  } else if (stored?.document instanceof GramJs.Document) {
    const d = stored.document;

    media = new GramJs.InputMediaDocument({
      id: new GramJs.InputDocument({
        id: d.id,
        accessHash: d.accessHash,
        fileReference: d.fileReference,
      }),
    });
  } else {
    throw new Error('Upload failed: Telegram returned no media');
  }

  return {
    media,
    caption: hideCaption ? '' : (m.message || ''),
    entities: hideCaption ? undefined : (m.entities as any[] | undefined),
  };
}

async function sendTextByDownload(job: Job, toPeer: any, item: Item) {
  await call(job, new GramJs.messages.SendMessage({
    peer: toPeer,
    message: item.m.message || '',
    entities: item.m.entities as any,
    randomId: generateRandomBigInt(),
  }));
}

async function sendSingleByDownload(
  job: Job,
  toPeer: any,
  item: Item,
  hideCaption: boolean,
) {
  if (item.kind === 'text') {
    await sendTextByDownload(job, toPeer, item);
    return;
  }

  const p = await prepareMedia(job, toPeer, item, hideCaption);

  await call(job, new GramJs.messages.SendMedia({
    peer: toPeer,
    media: p.media,
    message: p.caption,
    entities: p.entities as any,
    randomId: generateRandomBigInt(),
  }));
}

async function sendAlbumByDownload(
  job: Job,
  toPeer: any,
  items: Item[],
  hideCaption: boolean,
) {
  const prepared: Prepared[] = [];

  for (const item of items) {
    prepared.push(await prepareMedia(job, toPeer, item, hideCaption));
  }

  await call(job, new GramJs.messages.SendMultiMedia({
    peer: toPeer,
    multiMedia: prepared.map((p) => new GramJs.InputSingleMedia({
      media: p.media,
      randomId: generateRandomBigInt(),
      message: p.caption,
      entities: p.entities as any,
    })),
  }));
}

/** Album WITHOUT re-upload: SendMultiMedia that points at the files already stored on Telegram.
 *  (ForwardMessages can NOT make a new album - Telegram only keeps a group if the originals share one grouped_id.) */
async function sendAlbumByReference(
  job: Job,
  toPeer: any,
  items: Item[],
  hideCaption: boolean,
) {
  const multiMedia = items.map((item) => {
    const media: any = item.m.media;
    let input: any;

    if (item.kind === 'photo' && media?.photo instanceof GramJs.Photo) {
      const p = media.photo;

      input = new GramJs.InputMediaPhoto({
        id: new GramJs.InputPhoto({
          id: p.id,
          accessHash: p.accessHash,
          fileReference: p.fileReference,
        }),
      });
    } else if (media?.document instanceof GramJs.Document) {
      const d = media.document;

      input = new GramJs.InputMediaDocument({
        id: new GramJs.InputDocument({
          id: d.id,
          accessHash: d.accessHash,
          fileReference: d.fileReference,
        }),
      });
    } else {
      throw new Error('NO_MEDIA_REFERENCE');
    }

    return new GramJs.InputSingleMedia({
      media: input,
      randomId: generateRandomBigInt(),
      message: hideCaption ? '' : (item.m.message || ''),
      entities: hideCaption ? undefined : (item.m.entities as any),
    });
  });

  await call(job, new GramJs.messages.SendMultiMedia({
    peer: toPeer,
    multiMedia,
  }));
}

/* ------------------------------------------------------------------------------------------ */
/* Main job */

async function run(job: Job, params: StartMediaTransferParams) {
  const {
    fromChat,
    toChat,
    types,
    hideCaption,
    albums,
    skipIds,
    download,
  } = params;

  try {
    // Protected chat: forwarding is blocked, so download + re-upload (still sent as albums)
    const useDownload = Boolean(download || fromChat.isProtected);

    job.download = useDownload;
    job.copying = useDownload;

    const fromPeer = buildInputPeer(
      fromChat.id,
      fromChat.accessHash,
    );

    const toPeer = buildInputPeer(
      toChat.id,
      toChat.accessHash,
    );

    const messages = await collect(job, fromPeer);

    const skip = new Set(skipIds);

    const all: Item[] = [];

    messages.forEach((m) => {
      const { kind, album } = classify(m);

      if (kind && types[kind]) {
        all.push({
          m,
          kind,
          album,
        });
      }
    });

    /* Count selected media */

    (['video', 'photo', 'text'] as MediaTransferKind[]).forEach((k) => {
      if (!types[k]) return;

      job.tot[k] = all.filter(
        (i) => i.kind === k,
      ).length;

      job.cnt[k] = all.filter(
        (i) => i.kind === k && skip.has(i.m.id),
      ).length;
    });

    const todo = all.filter(
      (i) => !skip.has(i.m.id),
    );

    job.total = all.length;
    job.done = all.length - todo.length;

    if (job.cancel) {
      job.status = 'cancelled';
      return;
    }

    job.status = 'running';

    /* Progress */

    const markSent = (items: Item[]) => {
      items.forEach((i) => {
        job.cnt[i.kind] = (job.cnt[i.kind] || 0) + 1;
        job.sentIds.push(i.m.id);
      });

      job.done += items.length;
    };

    /* Download mode: one item at a time (a failed item is counted and the job goes on) */

    const sendOneByDownload = async (item: Item) => {
      if (job.cancel) return;

      try {
        await sendSingleByDownload(job, toPeer, item, hideCaption);

        markSent([item]);
      } catch (err) {
        if (job.cancel || errText(err).includes('CANCELLED')) {
          return;
        }

        const fatal = fatalOf(err);

        if (fatal) {
          throw new Error(fatal);
        }

        job.failed++;
        job.done++;
      }

      await sleep(DOWNLOAD_PAUSE_MS);
    };

    /* Fallback: send individually */

    const forwardOneByOne = async (items: Item[]) => {
      for (const item of items) {
        if (job.cancel) return;

        try {
          await forwardMessages(
            job,
            fromPeer,
            toPeer,
            [item],
            hideCaption,
          );

          markSent([item]);
        } catch (err) {
          if (job.cancel || errText(err).includes('CANCELLED')) {
            return;
          }

          const fatal = fatalOf(err);

          if (fatal) {
            throw new Error(fatal);
          }

          // Protected chat ("forwarding is restricted"): download + upload this one instead
          if (/RESTRICTED|NOFORWARDS|NO_FORWARDS/i.test(errText(err))) {
            await sendOneByDownload(item);
            continue;
          }

          job.failed++;
          job.done++;
        }

        await sleep(PAUSE_MS);
      }
    };

    /* Execute planned units */

    for (const unit of plan(todo, albums)) {
      if (job.cancel) break;

      /* ---- Download mode ---- */
      if (useDownload) {
        if (unit.album) {
          try {
            await sendAlbumByDownload(job, toPeer, unit.items, hideCaption);

            markSent(unit.items);

            await sleep(DOWNLOAD_PAUSE_MS);
          } catch (err) {
            if (job.cancel || errText(err).includes('CANCELLED')) break;

            const fatal = fatalOf(err);

            if (fatal) {
              throw new Error(fatal);
            }

            let sent = false;

            // retry the whole album once before giving up on grouping
            try {
              await sleep(DOWNLOAD_PAUSE_MS);
              await sendAlbumByDownload(job, toPeer, unit.items, hideCaption);
              markSent(unit.items);
              sent = true;
            } catch (err2) {
              if (job.cancel || errText(err2).includes('CANCELLED')) break;

              const fatal2 = fatalOf(err2);

              if (fatal2) {
                throw new Error(fatal2);
              }

              job.error = `Album failed (${errText(err2).slice(0, 120)}) - sent as single files`;
            }

            if (!sent) {
              // last resort: send its files one by one so nothing is lost
              for (const item of unit.items) {
                await sendOneByDownload(item);
              }
            }
          }
        } else {
          for (const item of unit.items) {
            if (job.cancel) break;

            await sendOneByDownload(item);
          }
        }

        continue;
      }

      /* ---- Forward mode ---- */
      try {
        if (unit.album) {
          // real album (forwarding can never create one)
          await sendAlbumByReference(job, toPeer, unit.items, hideCaption);
        } else {
          await forwardMessages(
            job,
            fromPeer,
            toPeer,
            unit.items,
            hideCaption,
          );
        }

        markSent(unit.items);
      } catch (err) {
        if (job.cancel) break;

        const fatal = fatalOf(err);

        if (fatal) {
          throw new Error(fatal);
        }

        let recovered = false;

        if (unit.album) {
          // protected chat or bad file reference: download + re-upload, still as ONE album
          try {
            await sendAlbumByDownload(job, toPeer, unit.items, hideCaption);
            markSent(unit.items);
            recovered = true;
          } catch (err2) {
            if (job.cancel) break;

            const fatal2 = fatalOf(err2);

            if (fatal2) {
              throw new Error(fatal2);
            }

            job.error = `Album failed (${errText(err2).slice(0, 120)}) - sent as single files`;
          }
        }

        if (!recovered) {
          await forwardOneByOne(unit.items);
        }
      }

      await sleep(PAUSE_MS);
    }

    job.status = job.cancel ? 'cancelled' : 'done';
  } catch (err) {
    if (job.cancel || errText(err).includes('CANCELLED')) {
      job.status = 'cancelled';
    } else {
      job.status = 'error';

      job.error = errText(err).replace(
        /^Error:\s*/,
        '',
      );
    }
  } finally {
    job.note = undefined;
  }
}
