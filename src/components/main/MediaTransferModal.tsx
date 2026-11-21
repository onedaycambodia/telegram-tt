import type { ChangeEvent } from 'react';
import React, {
  memo, useEffect, useMemo, useState,
} from '../../lib/teact/teact';
import { withGlobal } from '../../global';

import type { ApiChat, ApiUser } from '../../api/types';
import type { MediaTransferKind } from '../../api/gramjs/methods/mediaTransfer';

import buildClassName from '../../util/buildClassName';
import {
  closeMediaTransfer,
  dismissMediaTransfer,
  getMediaTransferState,
  resumeServerJob,
  startMediaTransfer,
  stopMediaTransfer,
  subscribeMediaTransfer,
} from '../../util/mediaTransferStore';

import Button from '../ui/Button';
import Modal from '../ui/Modal';

import styles from './MediaTransferModal.module.scss';

type StateProps = {
  chatsById: Record<string, ApiChat>;
  orderedIds: string[];
  usersById: Record<string, ApiUser>;
  currentUserId?: string;
};

type Options = {
  video: boolean; photo: boolean; text: boolean; hide: boolean; albums: boolean;
};

const OPTS_KEY = 'mt-opts';
const DEFAULT_OPTS: Options = {
  video: true, photo: true, text: false, hide: true, albums: true,
};

const TILES: [keyof Options, string][] = [
  ['video', 'Videos'],
  ['photo', 'Photos'],
  ['text', 'Text'],
  ['hide', 'No captions'],
  ['albums', 'Albums'],
];

const SELECTED_TILES = ['hide', 'albums'];

const ROWS: [MediaTransferKind, string][] = [['video', 'Videos'], ['photo', 'Photos'], ['text', 'Text']];

const STATUS_TEXT = {
  preparing: 'Collecting',
  running: 'Sending',
  done: 'Done',
  cancelled: 'Stopped',
  error: 'Failed',
};

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

function readOpts(): Options {
  try {
    return { ...DEFAULT_OPTS, ...JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') };
  } catch (e) {
    return DEFAULT_OPTS;
  }
}

function useTransferState() {
  const [value, setValue] = useState(getMediaTransferState());
  useEffect(() => {
    setValue(getMediaTransferState());
    return subscribeMediaTransfer(() => setValue(getMediaTransferState()));
  }, []);
  return value;
}

const MediaTransferModal = ({
  chatsById, orderedIds, usersById, currentUserId,
}: StateProps) => {
  const {
    isOpen, chatId, job, messageIds, setupNote,
  } = useTransferState();
  const isSelection = Boolean(messageIds?.length);

  useEffect(() => {
    if (currentUserId) void resumeServerJob(currentUserId);
  }, [currentUserId]);

  // close by itself shortly after a successful transfer
  const finishedStatus = job?.status.status;
  useEffect(() => {
    if (!isOpen || finishedStatus !== 'done') return undefined;
    const closeTimer = window.setTimeout(() => {
      dismissMediaTransfer();
      closeMediaTransfer();
    }, 1200);
    return () => window.clearTimeout(closeTimer);
  }, [isOpen, finishedStatus]);

  const [opts, setOpts] = useState<Options>(readOpts);
  const [again, setAgain] = useState(false);
  const [query, setQuery] = useState('');
  const [targetId, setTargetId] = useState<string | undefined>();

  const titleOf = (chat: ApiChat) => {
    if (chat.id === currentUserId) return 'Saved Messages';
    if (chat.title) return chat.title;
    const user = usersById[chat.id];
    return (user && [user.firstName, user.lastName].filter(Boolean).join(' ')) || chat.id;
  };

  const source = chatId ? chatsById[chatId] : undefined;

  const targets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orderedIds
      .filter((id) => id !== chatId && chatsById[id])
      .map((id) => chatsById[id])
      .filter((c) => !q || titleOf(c).toLowerCase().includes(q))
      .slice(0, 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedIds, chatsById, chatId, query]);

  const toggle = (key: keyof Options) => {
    const next = { ...opts, [key]: !opts[key] };
    setOpts(next);
    try { localStorage.setItem(OPTS_KEY, JSON.stringify(next)); } catch (e) { /* ignore */ }
  };

  const target = targetId ? chatsById[targetId] : undefined;
  const canStart = Boolean(source && target && (isSelection || opts.video || opts.photo || opts.text));

  const handleStart = () => {
    if (!source || !target) return;
    void startMediaTransfer({
      fromChat: source,
      toChat: target,
      fromTitle: titleOf(source),
      toTitle: titleOf(target),
      types: isSelection
        ? { video: true, photo: true, text: true }
        : { video: opts.video, photo: opts.photo, text: opts.text },
      download: isSelection,
      messageIds: isSelection ? messageIds : undefined,
      hideCaption: opts.hide,
      albums: opts.albums,
      fresh: again,
      accountId: currentUserId,
    });
  };

  function renderForm() {
    return (
      <>
        <div className={styles.sub}>
          {isSelection ? `${messageIds!.length} selected` : 'Whole chat, oldest first'}
        </div>

        <div className={styles.label}>Options</div>
        <div className={styles.grid}>
          {TILES.filter(([key]) => !isSelection || SELECTED_TILES.includes(key)).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={buildClassName(styles.tile, opts[key] && styles.on)}
              onClick={() => toggle(key)}
            >
              <span className={styles.box}><CheckIcon /></span>
              <span className={styles.tileText}>{label}</span>
            </button>
          ))}
          {!isSelection && (
            <button
              type="button"
              className={buildClassName(styles.tile, again && styles.on)}
              onClick={() => setAgain(!again)}
            >
              <span className={styles.box}><CheckIcon /></span>
              <span className={styles.tileText}>Resend all</span>
            </button>
          )}
        </div>

        <div className={styles.label}>Send to</div>
        <input
          className={styles.search}
          placeholder="Search chat"
          value={query}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.currentTarget.value)}
        />
        <div className={styles.list}>
          {!targets.length && <div className={styles.empty}>No chats found</div>}
          {targets.map((c) => (
            <button
              key={c.id}
              type="button"
              className={buildClassName(styles.row, c.id === targetId && styles.on)}
              onClick={() => setTargetId(c.id)}
            >
              <span className={styles.avatar}>{titleOf(c).trim().charAt(0).toUpperCase() || '?'}</span>
              <span className={styles.name}>{titleOf(c)}</span>
            </button>
          ))}
        </div>

        <div className={styles.actions}>
          <Button isText onClick={closeMediaTransfer}>Cancel</Button>
          <Button disabled={!canStart} onClick={handleStart}>Start</Button>
        </div>
      </>
    );
  }

  function renderProgress() {
    if (!job) return undefined;
    const s = job.status;
    const running = s.status === 'preparing' || s.status === 'running';
    return (
      <>
        <div className={styles.sub}>{job.fromTitle} → {job.toTitle}</div>

        <div className={styles.progressTop}>
          <b>{STATUS_TEXT[s.status]}{s.status === 'preparing' ? ` (${s.collected})` : ''}</b>
          <span>{s.done} / {s.total}</span>
        </div>

        {ROWS.filter(([k]) => s.tot[k] !== undefined).map(([k, label]) => {
          const total = s.tot[k] || 0;
          const done = s.cnt[k] || 0;
          return (
            <div key={k} className={styles.progressRow}>
              <div className={styles.progressTop}>
                <span>{label}</span>
                <span>{done} / {total}</span>
              </div>
              <div className={styles.bar}><span style={`width: ${total ? (done / total) * 100 : 0}%`} /></div>
            </div>
          );
        })}

        {s.failed > 0 && <div className={styles.note}>{s.failed} failed</div>}
        {s.error && <div className={styles.error}>{s.error}</div>}
        {setupNote && <div className={styles.note}>{setupNote}</div>}
        {s.note && <div className={styles.note}>{s.note}</div>}
        {running && <div className={styles.note}>Runs in the background</div>}

        <div className={styles.actions}>
          {running ? (
            <>
              <Button isText onClick={closeMediaTransfer}>Hide</Button>
              <Button color="danger" onClick={stopMediaTransfer}>Stop</Button>
            </>
          ) : (
            <Button onClick={() => { dismissMediaTransfer(); closeMediaTransfer(); }}>Close</Button>
          )}
        </div>
      </>
    );
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={closeMediaTransfer}
      className={styles.root}
      title={(job ? Boolean(job.selected) : isSelection) ? 'Send selected' : 'Media Transfer'}
      hasCloseButton
    >
      {job ? renderProgress() : renderForm()}
    </Modal>
  );
};

export default memo(withGlobal<{}>(
  (global): StateProps => ({
    chatsById: global.chats.byId,
    orderedIds: [...(global.chats.listIds.active || []), ...(global.chats.listIds.archived || [])],
    usersById: global.users.byId,
    currentUserId: global.currentUserId,
  }),
)(MediaTransferModal));
