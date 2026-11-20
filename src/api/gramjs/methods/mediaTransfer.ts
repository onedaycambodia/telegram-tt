/**
 * All Media Transfer - worker side (GramJS).
 * Runs the whole job inside the API worker so it keeps going while the UI is busy.
 * The UI polls getMediaTransferStatus() and can stop the job with cancelMediaTransfer().
 *
 * "Copied by this account": messages are forwarded with dropAuthor (no "Forwarded from"),
 * albums are rebuilt from the files Telegram already has (nothing is downloaded / re-uploaded).
 */
import { Api as GramJs } from '../../../lib/gramjs';

import type { ApiChat } from '../../types';

import { buildInputPeer } from '../gramjsBuilders';
import { generateRandomBigInt } from '../helpers';
import { invokeRequest } from './client';

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
  /** message ids sent since the previous poll - the UI stores them as the "history" ledger */
  sentIds: number[];
};

type Job = MediaTransferStatus & { cancel: boolean };
type Item = { m: GramJs.Message; kind: MediaTransferKind; album: boolean };
type Unit = { album: boolean; items: Item[] };

export type StartMediaTransferParams = {
  jobId: string;
  fromChat: ApiChat;
  toChat: ApiChat;
  types: MediaTransferTypes;
  hideCaption: boolean;
  albums: boolean;
  /** ids already sent earlier (history). Empty when "Send everything again" is on. */
  skipIds: number[];
};

const jobs = new Map<string, Job>();

const ALBUM_MIN = 5;
const ALBUM_MAX = 6; // "random 5-6" (Telegram allows up to 10)
const FORWARD_BATCH = 100;
const PAUSE_MS = 400;
const FATAL = [
  'CHAT_FORWARDS_RESTRICTED', 'CHAT_WRITE_FORBIDDEN', 'CHAT_ADMIN_REQUIRED', 'USER_BANNED_IN_CHANNEL',
  'PEER_ID_INVALID', 'CHANNEL_PRIVATE', 'CHAT_SEND_PHOTOS_FORBIDDEN', 'CHAT_SEND_MEDIA_FORBIDDEN',
];

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
const albumSize = () => ALBUM_MIN + Math.floor(Math.random() * (ALBUM_MAX - ALBUM_MIN + 1));
const errText = (err: unknown) => String((err as any)?.message || (err as any)?.errorMessage || err);

export function startMediaTransfer(params: StartMediaTransferParams) {
  const job: Job = {
    status: 'preparing', collected: 0, total: 0, done: 0, failed: 0, tot: {}, cnt: {}, sentIds: [], cancel: false,
  };
  jobs.set(params.jobId, job);
  void run(job, params);
  return { jobId: params.jobId };
}

export function getMediaTransferStatus(jobId: string): MediaTransferStatus | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  const { cancel, ...snapshot } = job;
  const result = { ...snapshot, tot: { ...job.tot }, cnt: { ...job.cnt }, sentIds: job.sentIds };
  job.sentIds = [];
  return result;
}

export function cancelMediaTransfer(jobId: string) {
  const job = jobs.get(jobId);
  if (job) job.cancel = true;
}

/* ------------------------------------------------------------------------------------------ helpers */

function classify(m: GramJs.Message): { kind?: MediaTransferKind; album: boolean } {
  const { media } = m;
  if (!media || media instanceof GramJs.MessageMediaEmpty || media instanceof GramJs.MessageMediaWebPage) {
    return { kind: m.message ? 'text' : undefined, album: false };
  }
  if (media instanceof GramJs.MessageMediaPhoto) {
    if (!(media.photo instanceof GramJs.Photo) || media.ttlSeconds) return { album: false };
    return { kind: 'photo', album: true };
  }
  if (media instanceof GramJs.MessageMediaDocument) {
    const doc = media.document;
    if (!(doc instanceof GramJs.Document) || media.ttlSeconds) return { album: false };
    const video = doc.attributes.find((a) => a instanceof GramJs.DocumentAttributeVideo) as
      GramJs.DocumentAttributeVideo | undefined;
    const isGif = doc.attributes.some((a) => a instanceof GramJs.DocumentAttributeAnimated);
    const isSticker = doc.attributes.some((a) => a instanceof GramJs.DocumentAttributeSticker);
    if (!video || isGif || isSticker || video.roundMessage) return { album: false };
    return { kind: 'video', album: doc.mimeType !== 'video/webm' };
  }
  return { album: false };
}

function toInputMedia(media: GramJs.TypeMessageMedia) {
  if (media instanceof GramJs.MessageMediaPhoto && media.photo instanceof GramJs.Photo) {
    const { id, accessHash, fileReference } = media.photo;
    return new GramJs.InputMediaPhoto({ id: new GramJs.InputPhoto({ id, accessHash, fileReference }) });
  }
  if (media instanceof GramJs.MessageMediaDocument && media.document instanceof GramJs.Document) {
    const { id, accessHash, fileReference } = media.document;
    return new GramJs.InputMediaDocument({ id: new GramJs.InputDocument({ id, accessHash, fileReference }) });
  }
  throw new Error('UNSUPPORTED_MEDIA');
}

/** invokeRequest + FLOOD_WAIT handling + cancel check */
async function call(job: Job, request: any): Promise<any> {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (job.cancel) throw new Error('CANCELLED');
    try {
      return await invokeRequest(request, { shouldThrow: true });
    } catch (err) {
      const text = errText(err);
      const flood = text.match(/FLOOD_WAIT_?(\d+)|wait of (\d+) seconds/i);
      if (!flood) throw err;
      await sleep((Number(flood[1] || flood[2]) + 1) * 1000);
    }
  }
  throw new Error('FLOOD_WAIT');
}

function fatalOf(err: unknown) {
  const text = errText(err);
  return FATAL.find((f) => text.includes(f));
}

/** Whole history, oldest -> newest */
async function collect(job: Job, fromPeer: any) {
  const all: GramJs.Message[] = [];
  let offsetId = 0;
  while (!job.cancel) {
    const res = await call(job, new GramJs.messages.GetHistory({
      peer: fromPeer, offsetId, offsetDate: 0, addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: BigInt(0),
    }));
    const raw: any[] = res?.messages || [];
    if (!raw.length) break;
    raw.forEach((m) => { if (m instanceof GramJs.Message) all.push(m); });
    offsetId = Math.min(...raw.map((m) => m.id));
    job.collected = all.length;
    await sleep(150);
  }
  return all.sort((a, b) => a.id - b.id);
}

/** Turns the ordered items into album units (random 5-6) and plain forward batches, keeping the order. */
function plan(items: Item[], albums: boolean): Unit[] {
  const units: Unit[] = [];
  let fwd: Item[] = [];
  let carry: Item[] = [];
  let target = albumSize();

  const flushFwd = () => { if (fwd.length) units.push({ album: false, items: fwd }); fwd = []; };
  const flushCarry = () => {
    if (carry.length >= 2) { flushFwd(); units.push({ album: true, items: carry }); } else fwd.push(...carry);
    carry = [];
    target = albumSize();
  };

  items.forEach((item) => {
    if (albums && item.album) {
      carry.push(item);
      if (carry.length >= target) flushCarry();
      return;
    }
    flushCarry();
    fwd.push(item);
    if (fwd.length >= FORWARD_BATCH) flushFwd();
  });
  flushCarry();
  flushFwd();
  return units;
}

/* ------------------------------------------------------------------------------------------ job */

async function run(job: Job, params: StartMediaTransferParams) {
  const {
    fromChat, toChat, types, hideCaption, albums, skipIds,
  } = params;
  try {
    const fromPeer = buildInputPeer(fromChat.id, fromChat.accessHash);
    const toPeer = buildInputPeer(toChat.id, toChat.accessHash);

    const messages = await collect(job, fromPeer);
    const skip = new Set(skipIds);
    const all: Item[] = [];
    messages.forEach((m) => {
      const { kind, album } = classify(m);
      if (kind && types[kind]) all.push({ m, kind, album });
    });
    (['video', 'photo', 'text'] as MediaTransferKind[]).forEach((k) => {
      if (!types[k]) return;
      job.tot[k] = all.filter((i) => i.kind === k).length;
      job.cnt[k] = all.filter((i) => i.kind === k && skip.has(i.m.id)).length;
    });
    const todo = all.filter((i) => !skip.has(i.m.id));
    job.total = all.length;
    job.done = all.length - todo.length;

    if (job.cancel) { job.status = 'cancelled'; return; }
    job.status = 'running';

    const markSent = (items: Item[]) => {
      items.forEach((i) => {
        job.cnt[i.kind] = (job.cnt[i.kind] || 0) + 1;
        job.sentIds.push(i.m.id);
      });
      job.done += items.length;
    };

    const forward = (items: Item[]) => call(job, new GramJs.messages.ForwardMessages({
      fromPeer,
      toPeer,
      id: items.map((i) => i.m.id),
      randomId: items.map(() => generateRandomBigInt()),
      dropAuthor: true,
      dropMediaCaptions: hideCaption || undefined,
    }));

    const forwardOneByOne = async (items: Item[]) => {
      for (const item of items) {
        if (job.cancel) return;
        try {
          await forward([item]);
          markSent([item]);
        } catch (err) {
          if (errText(err) === 'Error: CANCELLED' || job.cancel) return;
          const fatal = fatalOf(err);
          if (fatal) throw new Error(fatal);
          job.failed++;
          job.done++;
        }
        await sleep(PAUSE_MS);
      }
    };

    const sendAlbum = (items: Item[]) => call(job, new GramJs.messages.SendMultiMedia({
      peer: toPeer,
      multiMedia: items.map(({ m }) => new GramJs.InputSingleMedia({
        media: toInputMedia(m.media!),
        randomId: generateRandomBigInt(),
        message: hideCaption ? '' : m.message || '',
        entities: hideCaption ? undefined : m.entities,
      })),
    }));

    for (const unit of plan(todo, albums)) {
      if (job.cancel) break;
      try {
        if (unit.album) {
          try {
            await sendAlbum(unit.items);
            markSent(unit.items);
          } catch (err) {
            if (job.cancel || fatalOf(err)) throw err;
            await forwardOneByOne(unit.items); // album rejected -> keep the items, send them one by one
          }
        } else {
          try {
            await forward(unit.items);
            markSent(unit.items);
          } catch (err) {
            if (job.cancel || fatalOf(err)) throw err;
            await forwardOneByOne(unit.items);
          }
        }
      } catch (err) {
        if (job.cancel) break;
        const fatal = fatalOf(err);
        if (fatal) throw new Error(fatal);
        job.failed += unit.items.length;
        job.done += unit.items.length;
      }
      await sleep(PAUSE_MS);
    }

    job.status = job.cancel ? 'cancelled' : 'done';
  } catch (err) {
    if (job.cancel || errText(err).includes('CANCELLED')) {
      job.status = 'cancelled';
    } else {
      job.status = 'error';
      job.error = errText(err).replace(/^Error:\s*/, '');
    }
  }
}
