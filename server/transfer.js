'use strict';
/**
 * All Media Transfer - SERVER side (Node + GramJS).
 * Same behaviour as src/api/gramjs/methods/mediaTransfer.ts, but it runs here on Railway,
 * so it keeps going when the phone leaves Safari / locks the screen.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const bigInt = require('big-integer');
const { Api } = require('telegram');
const { generateRandomBigInt } = require('telegram/Helpers');
const { CustomFile } = require('telegram/client/uploads');

const ALBUM_MIN = 4; // Session-Login uses 4 per album: smaller albums fail less often
const ALBUM_MAX = 4;
const FORWARD_BATCH = 100;
const PAUSE_MS = 400;
const DOWNLOAD_PAUSE_MS = 500;
const PARALLEL_FILES = 2; // files are stored on disk while copying - keep this low for big videos
const TMP_DIR = process.env.TMP_DIR || os.tmpdir();
const UPLOAD_WORKERS = 4;
const FLOOD_TRIES = 20;
const FLOOD_MAX_S = 3700;
const NET_TRIES = 6;
const STALL_MS = 10 * 60 * 1000;

const FATAL = [
  'CHAT_WRITE_FORBIDDEN', 'CHAT_ADMIN_REQUIRED', 'USER_BANNED_IN_CHANNEL', 'PEER_ID_INVALID',
  'CHANNEL_PRIVATE', 'CHAT_SEND_PHOTOS_FORBIDDEN', 'CHAT_SEND_MEDIA_FORBIDDEN',
  // The account's session itself is dead (terminated from Devices, or Telegram logged it out):
  // nothing else will work either, so stop immediately instead of retrying item by item.
  'AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'USER_DEACTIVATED', 'AUTH_KEY_INVALID',
];

// Same list, used to recognize a dead session and to tell the client it can relink automatically.
const TERMINATED_SESSION_ERRORS = ['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'USER_DEACTIVATED', 'AUTH_KEY_INVALID'];

const jobs = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const albumSize = () => ALBUM_MIN + Math.floor(Math.random() * (ALBUM_MAX - ALBUM_MIN + 1));
const errText = (e) => String((e && (e.errorMessage || e.message)) || e);
const isSessionDead = (err) => TERMINATED_SESSION_ERRORS.some((s) => errText(err).includes(s));

// Set by createEngine(); called once per job the moment its session is found dead, so the server
// can drop the stored session for that account and let the client relink it automatically.
let onSessionDeadHandler;

/* ------------------------------------------------------------------ peers */

function peerOf(chat) {
  if (chat.isSelf) return new Api.InputPeerSelf();
  const id = String(chat.id);
  const hash = chat.accessHash ? bigInt(String(chat.accessHash)) : bigInt.zero;
  if (id.startsWith('-100')) return new Api.InputPeerChannel({ channelId: bigInt(id.slice(4)), accessHash: hash });
  if (id.startsWith('-')) return new Api.InputPeerChat({ chatId: bigInt(id.slice(1)) });
  return new Api.InputPeerUser({ userId: bigInt(id), accessHash: hash });
}

function channelOf(chat) {
  return new Api.InputChannel({
    channelId: bigInt(String(chat.id).slice(4)),
    accessHash: chat.accessHash ? bigInt(String(chat.accessHash)) : bigInt.zero,
  });
}

const isChannelChat = (chat) => String(chat.id).startsWith('-100');

/* ------------------------------------------------------------------ classify */

function classify(m) {
  const media = m.media;
  if (!media || media instanceof Api.MessageMediaEmpty || media instanceof Api.MessageMediaWebPage) {
    return { kind: m.message ? 'text' : undefined, album: false };
  }
  if (media instanceof Api.MessageMediaPhoto) {
    if (!(media.photo instanceof Api.Photo) || media.ttlSeconds) return { album: false };
    return { kind: 'photo', album: true };
  }
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document;
    if (!(doc instanceof Api.Document) || media.ttlSeconds) return { album: false };
    const video = doc.attributes.find((a) => a instanceof Api.DocumentAttributeVideo);
    const isGif = doc.attributes.some((a) => a instanceof Api.DocumentAttributeAnimated);
    const isSticker = doc.attributes.some((a) => a instanceof Api.DocumentAttributeSticker);
    if (!video || isGif || isSticker || video.roundMessage) return { album: false };
    return { kind: 'video', album: doc.mimeType !== 'video/webm' };
  }
  return { album: false };
}

/* ------------------------------------------------------------------ flood / retry */

function floodSeconds(err) {
  const direct = Number(err && err.seconds);
  if (direct > 0) return direct;
  const m = errText(err).match(/FLOOD_WAIT_?(\d+)|SLOWMODE_WAIT_?(\d+)|wait of (\d+) seconds/i);
  return m ? Number(m[1] || m[2] || m[3]) : 0;
}

const isTransient = (err) => /timeout|timed out|stalled|connection|socket|network|disconnect|closed|ECONN|EPIPE|Not connected/i
  .test(errText(err));

async function waitFlood(job, seconds) {
  const end = Date.now() + (Math.min(seconds, FLOOD_MAX_S) + 1) * 1000;
  while (!job.cancel) {
    const left = end - Date.now();
    if (left <= 0) break;
    job.note = `Telegram FloodWait - resuming in ${Math.ceil(left / 1000)}s`;
    await sleep(Math.min(left, 1000));
  }
  job.note = undefined;
}

async function withRetry(job, fn) {
  let floods = 0;
  let nets = 0;
  for (;;) {
    if (job.cancel) throw new Error('CANCELLED');
    try {
      return await fn();
    } catch (err) {
      if (job.cancel) throw new Error('CANCELLED');
      if (isSessionDead(err) && !job.sessionDeadReported) {
        job.sessionDeadReported = true;
        if (onSessionDeadHandler) {
          try { await onSessionDeadHandler(job.accountId); } catch (e2) { /* best effort */ }
        }
      }
      const seconds = floodSeconds(err);
      if (seconds && floods < FLOOD_TRIES) { floods++; await waitFlood(job, seconds); continue; }
      if (!seconds && isTransient(err) && nets < NET_TRIES) { nets++; await sleep(Math.min(5000 * nets, 30000)); continue; }
      throw err;
    }
  }
}

function stallGuard(job, what, run) {
  return new Promise((resolve, reject) => {
    let last = Date.now();
    let finished = false;
    const finish = (fn) => { if (finished) return; finished = true; clearInterval(timer); fn(); };
    const timer = setInterval(() => {
      if (job.cancel) finish(() => reject(new Error('CANCELLED')));
      else if (Date.now() - last > STALL_MS) finish(() => reject(new Error(`${what} stalled - no data for ${STALL_MS / 1000}s (timeout)`)));
    }, 5000);
    run(() => { last = Date.now(); }).then((v) => finish(() => resolve(v)), (e) => finish(() => reject(e)));
  });
}

const fatalOf = (err) => FATAL.find((f) => errText(err).includes(f));

/* ------------------------------------------------------------------ transfer engine */

function cleanOldTemp() {
  try {
    const now = Date.now();
    fs.readdirSync(TMP_DIR).forEach((f) => {
      if (!/^tt-[a-z0-9]+-\d+(\.part)?$/.test(f)) return;
      const fp = path.join(TMP_DIR, f);
      try { if (now - fs.statSync(fp).mtimeMs > 2 * 3600 * 1000) fs.unlinkSync(fp); } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }
}

function createEngine(getClient, onSessionDead) {
  onSessionDeadHandler = onSessionDead;
  cleanOldTemp(); // leftovers of a crashed / restarted server would slowly fill the disk
  setInterval(cleanOldTemp, 3600 * 1000).unref();
  const call = (job, request) => withRetry(job, async () => (await getClient(job.accountId)).invoke(request));

  async function collect(job, fromPeer) {
    const all = [];
    let offsetId = 0;
    while (!job.cancel) {
      const res = await call(job, new Api.messages.GetHistory({
        peer: fromPeer, offsetId, offsetDate: 0, addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: bigInt.zero,
      }));
      const raw = (res && res.messages) || [];
      if (!raw.length) break;
      raw.forEach((m) => { if (m instanceof Api.Message) all.push(m); });
      offsetId = Math.min(...raw.map((m) => m.id));
      job.collected = all.length;
      await sleep(150);
    }
    return all.sort((a, b) => a.id - b.id);
  }

  async function fetchSelected(job, chat, ids) {
    const all = [];
    for (let i = 0; i < ids.length && !job.cancel; i += 100) {
      const input = ids.slice(i, i + 100).map((id) => new Api.InputMessageID({ id }));
      const res = await call(job, isChannelChat(chat)
        ? new Api.channels.GetMessages({ channel: channelOf(chat), id: input })
        : new Api.messages.GetMessages({ id: input }));
      ((res && res.messages) || []).forEach((m) => { if (m instanceof Api.Message) all.push(m); });
      job.collected = all.length;
      await sleep(150);
    }
    return all.sort((a, b) => a.id - b.id);
  }

  function plan(items, albums) {
    const units = [];
    let fwd = [];
    let carry = [];
    let target = albumSize();
    const flushFwd = () => { if (fwd.length) units.push({ album: false, items: fwd }); fwd = []; };
    const flushCarry = () => {
      if (carry.length >= 2) { flushFwd(); units.push({ album: true, items: carry }); } else fwd.push(...carry);
      carry = [];
      target = albumSize();
    };
    items.forEach((item) => {
      if (albums && item.album) { carry.push(item); if (carry.length >= target) flushCarry(); return; }
      flushCarry();
      fwd.push(item);
      if (fwd.length >= FORWARD_BATCH) flushFwd();
    });
    flushCarry();
    flushFwd();
    return units;
  }

  async function forwardMessages(job, fromPeer, toPeer, items, hideCaption) {
    if (!items.length) return;
    await call(job, new Api.messages.ForwardMessages({
      fromPeer, toPeer,
      id: items.map((i) => i.m.id),
      randomId: items.map(() => generateRandomBigInt()),
      dropAuthor: true,
      dropMediaCaptions: hideCaption || undefined,
    }));
  }

  /* album WITHOUT re-upload: points at files that already exist on Telegram */
  async function sendAlbumByReferenceFresh(job, toPeer, items, hideCaption) {
    try {
      await sendAlbumByReference(job, toPeer, items, hideCaption);
    } catch (err) {
      if (!/FILE_REFERENCE|FILEREF/i.test(errText(err))) throw err;
      for (const item of items) await refetchItem(job, item); // old references expire after a few hours
      await sendAlbumByReference(job, toPeer, items, hideCaption);
    }
  }

  async function sendAlbumByReference(job, toPeer, items, hideCaption) {
    const multiMedia = items.map((item) => {
      const media = item.m.media;
      let input;
      if (item.kind === 'photo' && media.photo instanceof Api.Photo) {
        const p = media.photo;
        input = new Api.InputMediaPhoto({ id: new Api.InputPhoto({ id: p.id, accessHash: p.accessHash, fileReference: p.fileReference }) });
      } else if (media.document instanceof Api.Document) {
        const d = media.document;
        input = new Api.InputMediaDocument({ id: new Api.InputDocument({ id: d.id, accessHash: d.accessHash, fileReference: d.fileReference }) });
      } else throw new Error('NO_MEDIA_REFERENCE');
      return new Api.InputSingleMedia({
        media: input,
        randomId: generateRandomBigInt(),
        message: hideCaption ? '' : (item.m.message || ''),
        entities: hideCaption ? undefined : item.m.entities,
      });
    });
    await call(job, new Api.messages.SendMultiMedia({ peer: toPeer, multiMedia }));
  }

  function fileNameOf(m, kind) {
    const attrs = (m.media && m.media.document && m.media.document.attributes) || [];
    const named = attrs.find((a) => a instanceof Api.DocumentAttributeFilename);
    if (named && named.fileName) return String(named.fileName);
    return `${m.id}.${kind === 'photo' ? 'jpg' : 'mp4'}`;
  }

  /* the preview picture of a video - without it Telegram shows a black/empty tile */
  async function downloadVideoThumb(client, m) {
    try {
      const doc = m.media && m.media.document;
      const thumbs = (doc && doc.thumbs) || [];
      let index = -1;
      thumbs.forEach((t, i) => { if (t instanceof Api.PhotoSize || t instanceof Api.PhotoSizeProgressive) index = i; });
      if (index < 0) return undefined;
      const data = await client.downloadMedia(m, { thumb: index });
      return Buffer.isBuffer(data) && data.length ? data : undefined;
    } catch (e) {
      return undefined;
    }
  }

  const fileSize = (p) => { try { return fs.statSync(p).size; } catch (e) { return 0; } };
  const freeMb = () => {
    try { const f = fs.statfsSync(TMP_DIR); return `${Math.round((f.bavail * f.bsize) / 1048576)} MB free`; } catch (e) { return 'free space unknown'; }
  };
  const freeBytes = () => {
    try { const f = fs.statfsSync(TMP_DIR); return f.bavail * f.bsize; } catch (e) { return Infinity; }
  };
  const mediaBytes = (m) => {
    try { const d = m.media && m.media.document; return d && d.size ? Number(d.size.toString()) : 0; } catch (e) { return 0; }
  };
  // the downloaded file is not needed once Telegram holds the uploaded copy
  const dropFile = (item) => {
    if (item.cachePath) { fs.unlink(item.cachePath, () => {}); item.cachePath = undefined; }
  };
  const dropCache = (item) => { dropFile(item); item.prepared = undefined; };

  async function topId(job, toPeer) {
    try {
      const res = await call(job, new Api.messages.GetHistory({
        peer: toPeer, offsetId: 0, offsetDate: 0, addOffset: 0, limit: 1, maxId: 0, minId: 0, hash: bigInt.zero,
      }));
      const raw = (res && res.messages) || [];
      return raw.length ? Math.max(...raw.map((x) => x.id)) : 0;
    } catch (e) { return null; }
  }

  /* did an album that raised an error (timeout / parse failure) reach the target anyway? Then do NOT send it again. */
  async function landed(job, toPeer, before, n) {
    if (before === null) return false;
    try {
      const res = await call(job, new Api.messages.GetHistory({
        peer: toPeer, offsetId: 0, offsetDate: 0, addOffset: 0, limit: n + 5, maxId: 0, minId: 0, hash: bigInt.zero,
      }));
      const fresh = ((res && res.messages) || []).filter((x) => x.id > before && x.out && x.media);
      return fresh.length >= n;
    } catch (e) { return false; }
  }

  /* fresh copy of the message (new file reference) - what Session-Login does with _refetch before a retry */
  async function refetchItem(job, item) {
    if (!job.fromChat) return;
    const keep = job.collected;
    try {
      const r = await fetchSelected(job, job.fromChat, [item.m.id]);
      if (r[0]) item.m = r[0];
    } catch (e) { /* keep the old message */ }
    job.collected = keep;
  }

  /* Download to disk: writes to <file>.part and renames when complete (like Session-Login's ensure_cached).
   * A finished file is kept in item.cachePath, so a retried / split album does NOT download it again. */
  async function downloadToDisk(job, item) {
    if (item.cachePath && fileSize(item.cachePath)) return item.cachePath;
    const client = await getClient(job.accountId);
    const base = path.join(TMP_DIR, `tt-${job.id}-${item.m.id}`);
    const part = `${base}.part`;
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) { await sleep(2000 * attempt); await refetchItem(job, item); }
      try {
        const need = mediaBytes(item.m);
        if (need && freeBytes() < need + 100 * 1048576) {
          throw new Error(`Not enough disk space: file needs ${Math.ceil(need / 1048576)} MB, ${freeMb()}`);
        }
        try { fs.unlinkSync(part); } catch (e) { /* no partial file */ }
        await withRetry(job, () => stallGuard(job, 'download', async (beat) => {
          await client.downloadMedia(item.m, { outputFile: part, progressCallback: beat });
        }));
        if (fileSize(part)) {
          fs.renameSync(part, base);
          item.cachePath = base;
          return base;
        }
        lastErr = new Error(`download finished but wrote 0 bytes (${part}, ${freeMb()})`);
      } catch (e) {
        if (job.cancel || errText(e).includes('CANCELLED') || fatalOf(e)) throw e;
        lastErr = e;
      }
      console.error(`[transfer] download of message ${item.m.id} failed (try ${attempt}/3): ${errText(lastErr)}`);
      try { fs.unlinkSync(part); } catch (e) { /* ignore */ }
    }
    throw new Error(`Could not download the file: ${errText(lastErr)}`);
  }

  async function prepareMedia(job, toPeer, item, hideCaption) {
    if (item.prepared) return item.prepared; // already uploaded in an earlier try of this album
    const client = await getClient(job.accountId);
    const { m, kind } = item;
    const name = fileNameOf(m, kind);

    // Every file goes to disk first (big videos cannot be held in memory), uploaded from there.
    {
      const tmpPath = await downloadToDisk(job, item);
      const size = fileSize(tmpPath);

      const inputFile = await withRetry(job, () => stallGuard(job, 'upload',
        (beat) => client.uploadFile({
          file: new CustomFile(name, size, tmpPath), workers: UPLOAD_WORKERS, onProgress: beat,
        })));

      let uploaded;
      if (kind === 'photo') {
        uploaded = new Api.InputMediaUploadedPhoto({ file: inputFile });
      } else {
        const doc = m.media.document;
        const attributes = doc.attributes.filter((a) => !(a instanceof Api.DocumentAttributeFilename));
        attributes.push(new Api.DocumentAttributeFilename({ fileName: name }));
        let thumb;
        const thumbData = await downloadVideoThumb(client, m);
        if (thumbData) {
          try {
            thumb = await client.uploadFile({ file: new CustomFile('thumb.jpg', thumbData.length, '', thumbData), workers: 1 });
          } catch (e) { thumb = undefined; }
        }
        uploaded = new Api.InputMediaUploadedDocument({
          file: inputFile, thumb, mimeType: doc.mimeType || 'video/mp4', attributes,
        });
      }

      const stored = await call(job, new Api.messages.UploadMedia({ peer: toPeer, media: uploaded }));
      let media;
      if (stored && stored.photo instanceof Api.Photo) {
        const p = stored.photo;
        media = new Api.InputMediaPhoto({ id: new Api.InputPhoto({ id: p.id, accessHash: p.accessHash, fileReference: p.fileReference }) });
      } else if (stored && stored.document instanceof Api.Document) {
        const d = stored.document;
        media = new Api.InputMediaDocument({ id: new Api.InputDocument({ id: d.id, accessHash: d.accessHash, fileReference: d.fileReference }) });
      } else throw new Error('Upload failed: Telegram returned no media');

      const result = { media, caption: hideCaption ? '' : (m.message || ''), entities: hideCaption ? undefined : m.entities };
      item.prepared = result;
      dropFile(item);
      return result;
    }
  }

  async function sendSingleByDownload(job, toPeer, item, hideCaption) {
    if (item.kind === 'text') {
      await call(job, new Api.messages.SendMessage({
        peer: toPeer, message: item.m.message || '', entities: item.m.entities, randomId: generateRandomBigInt(),
      }));
      return;
    }
    try {
      const p = await prepareMedia(job, toPeer, item, hideCaption);
      await call(job, new Api.messages.SendMedia({
        peer: toPeer, media: p.media, message: p.caption, entities: p.entities, randomId: generateRandomBigInt(),
      }));
    } finally {
      dropCache(item);
    }
  }

  async function sendAlbumByDownload(job, toPeer, items, hideCaption) {
    const prepared = new Array(items.length);
    let next = 0;
    let firstError;
    const worker = async () => {
      while (next < items.length && !job.cancel && !firstError) {
        const index = next++;
        try {
          prepared[index] = await prepareMedia(job, toPeer, items[index], hideCaption);
        } catch (e) {
          if (!firstError) firstError = e;
          return;
        }
      }
    };
    // wait for ALL workers: a failed album must not leave a worker still downloading the same file in the background
    await Promise.all(Array.from({ length: Math.min(PARALLEL_FILES, items.length) }, worker));
    if (job.cancel) throw new Error('CANCELLED');
    if (firstError) throw firstError;
    await call(job, new Api.messages.SendMultiMedia({
      peer: toPeer,
      multiMedia: prepared.map((p) => new Api.InputSingleMedia({
        media: p.media, randomId: generateRandomBigInt(), message: p.caption, entities: p.entities,
      })),
    }));
  }

  /* Album that does not give up on grouping: full album -> two smaller albums -> one retry -> single files.
   * Files already downloaded stay on disk (item.cachePath) so nothing is downloaded twice. */
  async function sendAlbumResilient(job, toPeer, items, hideCaption, markSent, sendOne) {
    const bail = (err) => {
      if (job.cancel || errText(err).includes('CANCELLED')) throw new Error('CANCELLED');
      const fatal = fatalOf(err);
      if (fatal) throw new Error(fatal);
    };
    const attempt = async (list) => {
      const before = await topId(job, toPeer);
      try {
        await sendAlbumByDownload(job, toPeer, list, hideCaption);
        markSent(list);
        await sleep(DOWNLOAD_PAUSE_MS);
        return;
      } catch (err) {
        bail(err);
        if (!floodSeconds(err) && await landed(job, toPeer, before, list.length)) {
          console.error(`[transfer] album raised "${errText(err)}" but is already in the target - not sending again`);
          markSent(list);
          return;
        }
        if (/FILE_REFERENCE|MEDIA_EMPTY|MEDIA_INVALID/i.test(errText(err))) list.forEach((i) => { i.prepared = undefined; });
        console.error(`[transfer] album of ${list.length} failed: ${errText(err)}`);
        if (list.length >= 4) {
          const mid = list.length >> 1;
          await attempt(list.slice(0, mid));
          await attempt(list.slice(mid));
          return;
        }
        await sleep(DOWNLOAD_PAUSE_MS);
        try {
          await sendAlbumByDownload(job, toPeer, list, hideCaption);
          markSent(list);
          return;
        } catch (err2) {
          bail(err2);
          job.error = `Album failed (${errText(err2).slice(0, 120)}) - sent as single files`;
        }
        for (const item of list) await sendOne(item);
      }
    };
    try {
      await attempt(items);
    } finally {
      items.forEach(dropCache);
    }
  }

  async function run(job, p) {
    const {
      fromChat, toChat, types, hideCaption, albums, skipIds = [], messageIds,
    } = p;
    try {
      job.fromChat = fromChat;
      let useDownload = Boolean(p.download || p.fromProtected);
      job.download = useDownload;
      job.copying = useDownload;

      const fromPeer = peerOf(fromChat);
      const toPeer = peerOf(toChat);

      const messages = messageIds && messageIds.length
        ? await fetchSelected(job, fromChat, messageIds)
        : await collect(job, fromPeer);

      const skip = new Set(skipIds);
      const all = [];
      messages.forEach((m) => {
        const { kind, album } = classify(m);
        if (kind && types[kind]) all.push({ m, kind, album });
      });

      ['video', 'photo', 'text'].forEach((k) => {
        if (!types[k]) return;
        job.tot[k] = all.filter((i) => i.kind === k).length;
        job.cnt[k] = all.filter((i) => i.kind === k && skip.has(i.m.id)).length;
      });

      const todo = all.filter((i) => !skip.has(i.m.id));
      job.total = all.length;
      job.done = all.length - todo.length;

      if (job.cancel) { job.status = 'cancelled'; return; }
      job.status = 'running';

      const markSent = (items) => {
        items.forEach((i) => { job.cnt[i.kind] = (job.cnt[i.kind] || 0) + 1; job.sent.push(i.m.id); });
        job.done += items.length;
      };

      const sendOneByDownload = async (item) => {
        if (job.cancel) return;
        try {
          await sendSingleByDownload(job, toPeer, item, hideCaption);
          markSent([item]);
        } catch (err) {
          if (job.cancel || errText(err).includes('CANCELLED')) return;
          const fatal = fatalOf(err);
          if (fatal) throw new Error(fatal);
          job.failed++;
          job.done++;
        }
        await sleep(DOWNLOAD_PAUSE_MS);
      };

      const forwardOneByOne = async (items) => {
        for (const item of items) {
          if (job.cancel) return;
          try {
            await forwardMessages(job, fromPeer, toPeer, [item], hideCaption);
            markSent([item]);
          } catch (err) {
            if (job.cancel || errText(err).includes('CANCELLED')) return;
            const fatal = fatalOf(err);
            if (fatal) throw new Error(fatal);
            if (/RESTRICTED|NOFORWARDS|NO_FORWARDS/i.test(errText(err))) { await sendOneByDownload(item); continue; }
            job.failed++;
            job.done++;
          }
          await sleep(PAUSE_MS);
        }
      };

      for (const unit of plan(todo, albums)) {
        if (job.cancel) break;

        if (useDownload) {
          if (unit.album) {
            await sendAlbumResilient(job, toPeer, unit.items, hideCaption, markSent, sendOneByDownload);
          } else {
            for (const item of unit.items) { if (job.cancel) break; await sendOneByDownload(item); }
          }
          continue;
        }

        try {
          if (unit.album) await sendAlbumByReferenceFresh(job, toPeer, unit.items, hideCaption);
          else await forwardMessages(job, fromPeer, toPeer, unit.items, hideCaption);
          markSent(unit.items);
        } catch (err) {
          if (job.cancel) break;
          const fatal = fatalOf(err);
          if (fatal) throw new Error(fatal);
          if (/RESTRICTED|NOFORWARDS|NO_FORWARDS|PROTECTED/i.test(errText(err))) {
            // protected source: stop trying references / forwards, go straight to download + upload from now on
            useDownload = true; job.download = true; job.copying = true;
          }
          let recovered = false;
          if (unit.album) {
            await sendAlbumResilient(job, toPeer, unit.items, hideCaption, markSent, sendOneByDownload);
            recovered = true;
          }
          if (!recovered) await forwardOneByOne(unit.items);
        }
        await sleep(PAUSE_MS);
      }

      job.status = job.cancel ? 'cancelled' : 'done';
    } catch (err) {
      if (job.cancel || errText(err).includes('CANCELLED')) job.status = 'cancelled';
      else { job.status = 'error'; job.error = errText(err).replace(/^Error:\s*/, ''); }
    } finally {
      job.note = undefined;
      job.finishedAt = Date.now();
    }
  }

  return {
    start(p) {
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const job = {
        id,
        accountId: String(p.accountId),
        status: 'preparing', collected: 0, total: 0, done: 0, failed: 0, tot: {}, cnt: {},
        sent: [], cancel: false,
        meta: {
          accountId: String(p.accountId),
          fromId: String(p.fromChat.id), toId: String(p.toChat.id),
          fromTitle: p.fromTitle || '', toTitle: p.toTitle || '', albums: Boolean(p.albums),
          selected: p.messageIds && p.messageIds.length ? p.messageIds.length : undefined,
        },
        startedAt: Date.now(),
      };
      jobs.set(id, job);
      if (jobs.size > 30) {
        const done = [...jobs.entries()].filter(([, j]) => ['done', 'error', 'cancelled'].includes(j.status)).slice(0, 10);
        done.forEach(([k]) => jobs.delete(k));
      }
      void run(job, p);
      return id;
    },
  };
}

function snapshot(job, since = 0) {
  return {
    id: job.id,
    meta: job.meta,
    status: {
      status: job.status, collected: job.collected, total: job.total, done: job.done, failed: job.failed,
      tot: { ...job.tot }, cnt: { ...job.cnt }, error: job.error, copying: job.copying, note: job.note,
      download: job.download,
      sentIds: job.sent.slice(since),
      sentCount: job.sent.length,
    },
  };
}

module.exports = {
  createEngine,
  isSessionDead,
  getJob: (id) => jobs.get(id),
  listJobs: () => [...jobs.values()].map((j) => ({ id: j.id, meta: j.meta, status: j.status, startedAt: j.startedAt })),
  snapshot,
};
