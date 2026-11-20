# All Media Transfer -> Ajaxy/telegram-tt (Telegram Web A)

Ported from Session-Login (Python/Pyrogram backend + ui.js) to a pure client-side feature.
No server needed: everything runs through the GramJS worker of telegram-tt.

## 1. Copy the files (same paths as in this folder)
- src/api/gramjs/methods/mediaTransfer.ts
- src/util/mediaTransferStore.ts
- src/components/main/MediaTransferModal.tsx
- src/components/main/MediaTransferModal.module.scss

## 2. Three small edits

### a) src/api/gramjs/methods/index.ts  - expose the worker methods
```ts
export * from './mediaTransfer';
```

### b) src/components/main/Main.tsx  - mount the modal
```tsx
import MediaTransferModal from './MediaTransferModal';
...
// inside the returned JSX, next to the other modals (e.g. near <Dialogs />):
<MediaTransferModal />
```

### c) src/components/middle/HeaderMenuContainer.tsx  - add the menu entry (chat "..." menu)
```tsx
import { openMediaTransfer } from '../../util/mediaTransferStore';
...
// with the other <MenuItem>s:
<MenuItem icon="forward" onClick={() => { openMediaTransfer(chatId); onClose(); }}>
  All Media Transfer
</MenuItem>
```
(`chatId` / `onClose` are already props of HeaderMenuContainer; if the names differ in your version, use those.)

## 3. Run
npm i && npm run dev  ->  open a chat -> "..." menu -> All Media Transfer.

## How it maps to the original
| Original option | Here |
|---|---|
| Send with: Source Account | "This account" - forwards with dropAuthor (no "Forwarded from") |
| Video / Photo / Text Chat | filters on raw messages (video excludes GIF, stickers, round videos) |
| Hide Caption | dropMediaCaptions (forward) / empty caption (albums) |
| Send as Albums (random 5-6) | messages.SendMultiMedia rebuilt from existing file ids - nothing downloaded/uploaded |
| Send everything again | ignores the history ledger |
| History / resume | ledger of sent message ids in localStorage per source->target pair |
| Progress + Stop | worker job polled every 0.8s; Stop cancels |

Not ported (not applicable in a single-account web client): Destination Account (Session B), convert 9:16, Railway/ffmpeg.

## Notes
- Written without access to the repo, so a few import names may differ slightly by version
  (generateRandomBigInt in ../helpers, buildInputPeer in ../gramjsBuilders, invokeRequest in ./client,
  hash: BigInt(0) in GetHistory). TypeScript will point to anything to adjust.
- Source chats with "Restrict saving content" cannot be forwarded - the job stops with CHAT_FORWARDS_RESTRICTED.
- The job lives in the browser tab: if the tab is closed it stops, and the next run resumes using the ledger.
