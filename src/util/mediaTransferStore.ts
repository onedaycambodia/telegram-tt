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
  status: MediaTransferStatus;
};

export type MediaTransferState = {
  isOpen: boolean;
  chatId?: string;
  /** set when opened from "select messages" - only these are transferred */
  messageIds?: number[];
  job?: MediaTransferJob;
};

const LEDGER_PREFIX = 'mt-ledger:';
const POLL_MS = 800;

let state: MediaTransferState = { isOpen: false };
const listeners = new Set<() => void>();
let timer: number | undefined;

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
}) {
  const {
    fromChat, toChat, fromTitle, toTitle, types, hideCaption, albums, fresh, download, messageIds,
  } = params;
  const id = `${Date.now()}`;
  const status: MediaTransferStatus = {
    status: 'preparing', collected: 0, total: 0, done: 0, failed: 0, tot: {}, cnt: {}, sentIds: [],
  };
  setState({
    job: {
      id, fromId: fromChat.id, toId: toChat.id, fromTitle, toTitle, albums, status,
    },
  });
  await callApi('startMediaTransfer', {
    jobId: id,
    fromChat,
    toChat,
    types,
    hideCaption,
    albums,
    download,
    messageIds,
    skipIds: fresh || messageIds?.length ? [] : readLedger(fromChat.id, toChat.id),
  });
  poll();
}

export function stopMediaTransfer() {
  if (state.job) void callApi('cancelMediaTransfer', state.job.id);
}
