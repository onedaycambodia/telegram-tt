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
  video: boolean; photo: boolean; text: boolean; hide: boolean; albums: boolean; direct: boolean;
};

const OPTS_KEY = 'mt-opts';
const DEFAULT_OPTS: Options = {
  video: true, photo: true, text: false, hide: true, albums: true, direct: false,
};

const TILES: [keyof Options, string, boolean][] = [
  ['video', 'Video', false],
  ['photo', 'Photo', false],
  ['text', 'Text Chat', false],
  ['hide', 'Hide Caption', false],
  ['albums', 'Send as Albums', false],
  ['direct', 'Force download + upload (slow - protected chats do it automatically)', true],
];

const SELECTED_TILES = ['hide', 'albums'];

const ROWS: [MediaTransferKind, string][] = [['video', 'Videos'], ['photo', 'Photo'], ['text', 'Text']];

const STATUS_TEXT = {
  preparing: 'Collecting messages',
  running: 'Transferring',
  done: 'Completed',
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
    isOpen, chatId, job, messageIds,
  } = useTransferState();
  const isSelection = Boolean(messageIds?.length);

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
      download: isSelection ? true : opts.direct,
      messageIds: isSelection ? messageIds : undefined,
      hideCaption: opts.hide,
      albums: opts.albums,
      fresh: again,
    });
  };

  function renderForm() {
    return (
      <>
        <div className={styles.head}>
          <span className={styles.badge}>➦</span>
          <div>
            <div className={styles.headTitle}>{isSelection ? 'Send selected' : 'All Media Transfer'}</div>
            <div className={styles.headSub}>
              {isSelection ? `${messageIds!.length} selected messages` : 'Entire chat, oldest to newest'}
            </div>
          </div>
        </div>

        <div className={styles.label}>Send with</div>
        <div className={buildClassName(styles.tile, styles.static, styles.on, styles.wide)}>
          <b>This account</b>
          <span className={styles.tileSub}>Copied by this account</span>
        </div>

        <div className={styles.label}>Include</div>
        <div className={styles.grid}>
          {TILES.filter(([key]) => !isSelection || SELECTED_TILES.includes(key)).map(([key, label, wide]) => (
            <button
              key={key}
              type="button"
              className={buildClassName(styles.tile, opts[key] && styles.on, wide && styles.wide)}
              onClick={() => toggle(key)}
            >
              <span className={styles.box}><CheckIcon /></span>
              <span>{label}</span>
            </button>
          ))}
          {!isSelection && (
            <button
              type="button"
              className={buildClassName(styles.tile, styles.wide, again && styles.on)}
              onClick={() => setAgain(!again)}
            >
              <span className={styles.box}><CheckIcon /></span>
              <span>Send everything again (ignore history)</span>
            </button>
          )}
        </div>

        <div className={styles.label}>Target chat</div>
        <input
          className={styles.search}
          placeholder="Search target chat..."
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
        <div className={styles.head}>
          <span className={styles.badge}>➦</span>
          <div>
            <div className={styles.headTitle}>{job.selected ? 'Send selected' : 'All Media Transfer'}</div>
            <div className={styles.headSub}>{job.fromTitle} → {job.toTitle}{job.albums ? ' · Albums' : ''}</div>
          </div>
        </div>

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
                <b>{label}</b>
                <span>{done} / {total} Messages</span>
              </div>
              <div className={styles.bar}><span style={`width: ${total ? (done / total) * 100 : 0}%`} /></div>
            </div>
          );
        })}

        {s.failed > 0 && <div className={styles.headSub}>{s.failed} failed</div>}
        {s.error && <div className={styles.error}>{s.error}</div>}
        {s.copying && <div className={styles.headSub}>Restricted chat: downloading and re-uploading (slower)</div>}
        {running && <div className={styles.headSub}>Keeps running if you close this window.</div>}

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
      title={(job ? Boolean(job.selected) : isSelection) ? 'Send selected' : 'All Media Transfer'}
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
