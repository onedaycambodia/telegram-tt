/**
 * All Media Transfer - tiny main-thread store (no changes to the global state needed).
 * Keeps the modal open/closed state, the running job, polls the worker and keeps the
 * "history" ledger in localStorage so a later run skips everything that was already sent.
 */
import { callApi } from '../api/gramjs';

import type { ApiChat } from '../api/types';
import type { MediaTransferStatus, MediaTransferTypes } from '../api/gramjs/methods/mediaTransfer';

export type MediaTransferJob = {
  id: string;
  fromId: string;
  toId: string;
  fromTitle: string;
  toTitle: string;
  albums: boolean;
  /** number of selected messages (set when started from "select") */
  selected?: number;
  /** true = the job runs on the server (keeps going when Safari is closed) */
  server?: boolean;
  status: MediaTransferStatus;
};

export type MediaTransferState = {
  isOpen: boolean;
  chatId?: string;
  /** set when opened from "select messages" - only these are transferred */
  messageIds?: number[];
  /** short text while this account is being linked to the server */
  setupNote?: string;
  job?: MediaTransferJob;
};

const LEDGER_PREFIX = 'mt-ledger:';
const POLL_MS = 800;
const SERVER_POLL_MS = 1500;
const TOKEN_KEY = 'mt-server-token';

let state: MediaTransferState = { isOpen: false };
const listeners = new Set<() => void>();
let timer: number | undefined;
let serverCursor = 0;
let linkAborted = false;

function setState(next: Partial<MediaTransferState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export const getMediaTransferState = () => state;

export function subscribeMediaTransfer(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function openMediaTransfer(chatId: string, messageIds?: number[]) {
  setState({ isOpen: true, chatId, messageIds });
}

export function closeMediaTransfer() {
  setState({ isOpen: false });
}

/** Clears a finished job so the form is shown again */
export function dismissMediaTransfer() {
  setState({ job: undefined });
}

/* ------------------------------------------------------------------ history ledger */

const ledgerKey = (from: string, to: string) => `${LEDGER_PREFIX}${from}:${to}`;

function readLedger(from: string, to: string): number[] {
  try {
    return JSON.parse(localStorage.getItem(ledgerKey(from, to)) || '[]');
  } catch (e) {
    return [];
  }
}

function appendLedger(from: string, to: string, ids: number[]) {
  try {
    const merged = Array.from(new Set([...readLedger(from, to), ...ids]));
    localStorage.setItem(ledgerKey(from, to), JSON.stringify(merged));
  } catch (e) {
    // storage full / unavailable - the transfer still works, it just cannot remember history
  }
}

export function getLedgerSize(from: string, to: string) {
  return readLedger(from, to).length;
}

/* ------------------------------------------------------------------ background server */

class ServerUnavailable extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

/** JSON call to the transfer server. Throws ServerUnavailable when there is no such server (plain static hosting). */
async function serverFetch(path: string, init: RequestInit = {}, canAsk = true): Promise<any> {
  let token = localStorage.getItem(TOKEN_KEY) || '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(path, {
        ...init,
        headers: { 'Content-Type': 'application/json', 'x-transfer-token': token },
      });
    } catch (e) {
      throw new ServerUnavailable();
    }
    if (!(res.headers.get('content-type') || '').includes('application/json')) throw new ServerUnavailable();
    if (res.status === 503) throw new ServerUnavailable();

    if (res.status === 401) {
      if (!canAsk) throw new ServerUnavailable();
      if (attempt === 1) {
        localStorage.removeItem(TOKEN_KEY);
        throw new Error('Wrong transfer password');
      }
      // eslint-disable-next-line no-alert
      const typed = window.prompt('Transfer password (TRANSFER_TOKEN on the server)');
      if (!typed) throw new ServerUnavailable();
      token = typed;
      localStorage.setItem(TOKEN_KEY, typed);
      continue;
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    return data;
  }
  throw new ServerUnavailable();
}

/** One-time per account: this logged-in browser accepts the server's QR token, the server keeps its own session. */
async function ensureLinked(accountId: string) {
  const ping = await serverFetch(`/transfer/ping?accountId=${accountId}`);
  if (ping.linked) return;
  if (!ping.hasApi) throw new Error('Set API_ID and API_HASH on the server (Railway variables)');

  setState({ setupNote: 'Linking this account to the server (one time)...' });
  await serverFetch('/transfer/login/qr/start', { method: 'POST', body: JSON.stringify({ accountId }) });

  const startedAt = Date.now();
  let lastToken = '';
  let acceptError = '';
  let accepted = 0;
  while (Date.now() - startedAt < 120000) {
    if (linkAborted) throw new Error('LINK_CANCELLED');
    const st = await serverFetch(`/transfer/login/qr/state?accountId=${accountId}`);
    if (st.status === 'done') { setState({ setupNote: undefined }); return; }
    if (st.status === 'error') throw new Error(st.error || 'Linking failed');
    if (st.status === 'none') throw new Error('Server lost the linking state (it restarted?) - try again');

    setState({
      setupNote: `Linking this account to the server... (server: ${st.status}, QR: ${st.token ? 'ready' : 'not yet'}`
        + `, accepted: ${accepted}${acceptError ? `, last error: ${acceptError}` : ''})`,
    });

    if (st.status === 'password') {
      // eslint-disable-next-line no-alert
      const password = window.prompt('2-step verification password of this account');
      if (!password) throw new Error('2-step verification password is required to link this account');
      await serverFetch('/transfer/login/qr/password', {
        method: 'POST', body: JSON.stringify({ accountId, password }),
      });
      await sleep(600);
      continue;
    }

    if (st.token && st.token !== lastToken) {
      lastToken = st.token;
      try {
        await Promise.race([
          callApi('acceptServerLoginToken', st.token),
          new Promise((_, reject) => { window.setTimeout(() => reject(new Error('accept timed out')), 20000); }),
        ]);
        accepted++;
        acceptError = '';
      } catch (e) {
        // an expired token is replaced by a fresh one on the next poll - the reason is shown in the note
        acceptError = e instanceof Error ? e.message : String(e);
      }
    }
    await sleep(1200);
  }
  throw new Error(`Linking timed out - ${acceptError ? `Telegram said: ${acceptError}` : 'the account never accepted the QR token'}`);
}

function pollServer() {
  window.clearTimeout(timer);
  timer = window.setTimeout(async () => {
    const job = state.job;
    if (!job || !job.server) return;
    try {
      const snap = await serverFetch(`/transfer/status/${job.id}?since=${serverCursor}`, {}, false);
      const status: MediaTransferStatus = snap.status;
      serverCursor = status.sentIds.length ? snap.status.sentCount : serverCursor;
      if (status.sentIds.length) appendLedger(job.fromId, job.toId, status.sentIds);
      setState({ job: { ...job, status: { ...status, sentIds: [] } } });
      if (isActive(status)) pollServer();
    } catch (e) {
      if (e instanceof Error && e.message === 'Job not found') {
        setState({
          job: { ...job, status: { ...job.status, status: 'error', error: 'Transfer was interrupted (server restarted)' } },
        });
        return;
      }
      pollServer();
    }
  }, SERVER_POLL_MS);
}

/** Opening the app again: if a transfer is still running on the server, show it. */
export async function resumeServerJob(accountId: string) {
  if (state.job || !localStorage.getItem(TOKEN_KEY)) return;
  try {
    const list = await serverFetch(`/transfer/jobs?accountId=${accountId}`, {}, false);
    const running = (list as any[]).find((j) => j.status === 'preparing' || j.status === 'running');
    if (!running || state.job) return;
    serverCursor = 0;
    setState({
      isOpen: true,
      chatId: running.meta.fromId,
      job: {
        id: running.id,
        fromId: running.meta.fromId,
        toId: running.meta.toId,
        fromTitle: running.meta.fromTitle,
        toTitle: running.meta.toTitle,
        albums: running.meta.albums,
        selected: running.meta.selected,
        server: true,
        status: {
          status: 'running', collected: 0, total: 0, done: 0, failed: 0, tot: {}, cnt: {}, sentIds: [],
        },
      },
    });
    pollServer();
  } catch (e) {
    // no server / not linked - nothing to resume
  }
}

/* ------------------------------------------------------------------ job control */

const isActive = (s: MediaTransferStatus) => s.status === 'preparing' || s.status === 'running';

function poll() {
  window.clearTimeout(timer);
  timer = window.setTimeout(async () => {
    const job = state.job;
    if (!job) return;
    try {
      const status = await callApi('getMediaTransferStatus', job.id);
      if (!status) {
        setState({
          job: { ...job, status: { ...job.status, status: 'error', error: 'Transfer was interrupted' } },
        });
        return;
      }
      if (status.sentIds.length) appendLedger(job.fromId, job.toId, status.sentIds);
      setState({ job: { ...job, status } });
      if (isActive(status)) poll();
    } catch (e) {
      poll();
    }
  }, POLL_MS);
}

export async function startMediaTransfer(params: {
  fromChat: ApiChat;
  toChat: ApiChat;
  fromTitle: string;
  toTitle: string;
  types: MediaTransferTypes;
  hideCaption: boolean;
  albums: boolean;
  /** "Send everything again (ignore history)" */
  fresh: boolean;
  /** download + upload every file (works for protected and unprotected chats) */
  download?: boolean;
  messageIds?: number[];
  /** the logged-in account (the server keeps one session per account) */
  accountId?: string;
}) {
  const {
    fromChat, toChat, fromTitle, toTitle, types, hideCaption, albums, fresh, download, messageIds, accountId,
  } = params;
  const id = `${Date.now()}`;
  const status: MediaTransferStatus = {
    status: 'preparing', collected: 0, total: 0, done: 0, failed: 0, tot: {}, cnt: {}, sentIds: [],
  };
  setState({
    job: {
      id, fromId: fromChat.id, toId: toChat.id, fromTitle, toTitle, albums, status, selected: messageIds?.length,
    },
  });
  const skipIds = fresh || messageIds?.length ? [] : readLedger(fromChat.id, toChat.id);
  linkAborted = false;

  // 1) background server (keeps running when Safari is closed) - 2) otherwise inside this browser, as before
  if (accountId) {
    try {
      await ensureLinked(accountId);
      const started = await serverFetch('/transfer/start', {
        method: 'POST',
        body: JSON.stringify({
          accountId,
          fromChat: { id: fromChat.id, accessHash: fromChat.accessHash, isSelf: fromChat.id === accountId },
          toChat: { id: toChat.id, accessHash: toChat.accessHash, isSelf: toChat.id === accountId },
          fromTitle,
          toTitle,
          fromProtected: Boolean(fromChat.isProtected),
          types,
          hideCaption,
          albums,
          download,
          messageIds,
          skipIds,
        }),
      });
      serverCursor = 0;
      setState({
        setupNote: undefined,
        job: {
          id: started.id, fromId: fromChat.id, toId: toChat.id, fromTitle, toTitle, albums, status, selected: messageIds?.length, server: true,
        },
      });
      pollServer();
      return;
    } catch (e) {
      setState({ setupNote: undefined });
      if (!(e instanceof ServerUnavailable)) {
        const cancelled = e instanceof Error && e.message === 'LINK_CANCELLED';
        setState({
          job: {
            id, fromId: fromChat.id, toId: toChat.id, fromTitle, toTitle, albums, selected: messageIds?.length,
            status: cancelled
              ? { ...status, status: 'cancelled' }
              : { ...status, status: 'error', error: e instanceof Error ? e.message : String(e) },
          },
        });
        return;
      }
    }
  }

  await callApi('startMediaTransfer', {
    jobId: id,
    fromChat,
    toChat,
    types,
    hideCaption,
    albums,
    download,
    messageIds,
    skipIds,
  });
  poll();
}

export function stopMediaTransfer() {
  const job = state.job;
  if (!job) return;
  if (job.server) {
    void serverFetch(`/transfer/cancel/${job.id}`, { method: 'POST' }, false).catch(() => undefined);
  } else if (state.setupNote) {
    linkAborted = true; // still linking the account - stop waiting
  } else {
    void callApi('cancelMediaTransfer', job.id);
  }
}
