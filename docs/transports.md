# Writing a transport adapter

A transport is a way into a space. It carries messages; it does not decide what
the assistant does with them. Behavior, memory, permissions, and knowledge all
belong to the space, so an adapter's whole job is translation in both
directions.

If you follow this document you should be able to add a new channel without
touching anything under `src/core/` or `src/gateway/`.

---

## The shape of it

```text
your service ──▶ adapter ──▶ IncomingMessage ──▶ MessageGateway ──▶ Space ──▶ agent
                                                                                │
your service ◀── adapter ◀── OutgoingMessage ◀── Outbox ◀────────────────────────┘
```

Everything crossing that middle column is defined in
[`src/transports/types.ts`](../src/transports/types.ts). Your service's SDK,
its ids, and its quirks stay on your side of it.

---

## 1. Implement `TransportAdapter`

```ts
import type {
    DeliveryResult,
    OutgoingMessage,
    TransportAdapter,
    TransportCapabilities,
    TransportDestination,
    TransportRuntimeContext,
} from '../types';

export class ExampleTransportAdapter implements TransportAdapter {
    readonly name = 'example';

    async start(context: TransportRuntimeContext): Promise<void> {
        // Subscribe to your service. For each event: normalize it, then hand
        // the result to the gateway and nothing else.
        //
        //   const message = normalizeExampleEvent(event);
        //   if (message) await context.messageGateway.handleIncoming(message);
    }

    async stop(): Promise<void> {
        // Close connections. Never register your own SIGINT handler — the
        // transport registry owns shutdown, and a second owner means the
        // connection gets closed twice.
    }

    async send(destination: TransportDestination, message: OutgoingMessage): Promise<DeliveryResult> {
        // One already-split piece. Report honestly:
        //   'sent'             — it went out
        //   'retryable_error'  — the service was unhappy; try again later
        //   'permanent_error'  — it will never work (unknown chat, no such
        //                        capability). Retrying only burns attempts.
        return { status: 'sent' };
    }

    async getCapabilities(): Promise<TransportCapabilities> {
        return EXAMPLE_CAPABILITIES;
    }
}
```

Two optional methods, worth knowing about:

- **`splitForDelivery(message)`** — return the pieces your service will
  physically send. Do this rather than splitting inside `send`: each piece
  becomes its own queue entry and retries alone. Splitting at send time means a
  failure halfway through a long answer re-sends the parts that already
  arrived, and the reader sees the beginning twice.
- **`resolveAttachment(attachment)`** — fetch the bytes behind a reference.
  A method rather than data on the attachment, so the gateway can defer the
  download until *after* the permission checks — otherwise a stranger could make
  the assistant fetch files just by sending them. Check the size before you
  buffer anything.

---

## 2. Normalize into `IncomingMessage`

Write this as a pure function over plain input, not against your SDK's types.
It stays testable from fixtures, and it means even the normalizer needs no SDK
import — see
[`transports/telegram/normalizer.ts`](../src/transports/telegram/normalizer.ts).

```ts
{
    id: buildIncomingMessageId('example', endpointId, externalMessageId),
    transportMessageId: externalMessageId,
    transport: 'example',
    endpoint: { id: endpointId, type: 'group', title: 'Team room' },
    sender: { transportUserId: '5150', displayName: 'Alex', username: 'alex' },
    content: { text: 'find the last document' },
    timestamp: new Date().toISOString(),
    correlationId: randomUUID(),
}
```

Things that trip people up:

| Field | What it must be |
| --- | --- |
| `id` | Always `buildIncomingMessageId(...)`. It is the deduplication key — deriving it from anything else lets a replayed event run the agent twice. It deliberately does **not** mention the space, so re-pointing a binding cannot resurrect a replay. |
| `endpoint.type` | One of `direct` / `group` / `channel` / `thread`. Map your service's own type into that set. When in doubt choose `group` — guessing `direct` hands a stranger the private-chat path. |
| `addressedToAssistant` | Your verdict on whether this was aimed at the assistant (a mention, a reply to its own message). Core needs the answer, not the mechanism. |
| `senderAuthenticated` | Only `true` if your transport **proved** who the sender is, the way a signed-in session does. A user id your service merely asserts is not proof; that is what the owner allowlist is for. |
| `metadata` | Transport trivia. Core never reads it — the file ids Telegram hands out live here. |
| unroutable events | Return `null` rather than throwing. A sticker or a service notice is not an error. |

---

## 3. Declare capabilities

Say what your service can carry, and its limits:

```ts
export const EXAMPLE_CAPABILITIES: TransportCapabilities = {
    ...MINIMAL_TRANSPORT_CAPABILITIES,
    markdown: true,
    attachments: true,
    maxTextLength: 4096,
};
```

`maxTextLength` is what your renderer measures against. Measure the text
**after** formatting: escaping expands it, so a chunk that fits before
formatting can overflow after.

---

## 4. Register it

In [`src/index.ts`](../src/index.ts), next to the others:

```ts
transportRegistry.registerTransport(new ExampleTransportAdapter());
```

Pass `{ required: true }` only if the runtime is pointless without it. An
optional transport that fails to start logs and is skipped; a required one
aborts the boot and unwinds whatever already came up.

---

## 5. Bind an endpoint to a space

A binding is what says "messages arriving here belong to that space". Existing
chat transports create one on first contact, which is why adding the bot to a
group just works:

```ts
ensureTransportBinding({
    transport: 'example',
    endpointId: 'room-17',
    endpointType: 'group',
    spaceId: space.id,
});
```

If your endpoints are created deliberately rather than discovered — the way web
rooms are — opt out of automatic creation in
[`gateway/binding-resolver.ts`](../src/gateway/binding-resolver.ts), so an
unknown endpoint surfaces as a mistake instead of conjuring a space.

One space can hold several bindings. Replies fan out to all of them, so a
conversation open on two surfaces stays in sync on both.

---

## 6. Test it

Follow what the repo already does:

- **Normalizer** — plain fixtures, no SDK, no database.
- **Renderer** — assert every piece fits the limit *after* formatting, and that
  splitting never leaves markup unbalanced.
- **Access** — whatever your transport's rule is, prove a stranger is refused.
- **Adapters themselves** are excluded from coverage (`src/transports/*/adapter.ts`):
  they are thin I/O shells, and the logic they wrap is tested directly.

---

## 7. What you may not import

Enforced by [`transports/boundary.test.ts`](../src/transports/boundary.test.ts),
which reads the source tree and fails on violations:

- Your SDK is importable **only** from your own adapter's files. Add them to
  `SDK_IMPORT_ALLOWLIST` and nowhere else.
- Modules holding a live connection stay out of `src/core/`, `src/agents/`, and
  `src/skills/`. Those send by calling `sendSpaceMessage`, which queues.
- Never send directly from an adapter's inbound path. Everything outbound goes
  through the outbox, which is what makes delivery survive a crash.

The allowlists have a pinned size, so a new exemption cannot be added quietly.

---

## Reference implementations

| Adapter | Worth reading for |
| --- | --- |
| [`transports/telegram/`](../src/transports/telegram/) | The full shape: normalizer, renderer with splitting, capabilities, attachment resolution. |
| [`transports/web/adapter.ts`](../src/transports/web/adapter.ts) | A transport whose inbound arrives over HTTP and whose "send" is a nudge to refetch. |
| [`transports/legacy-channel.ts`](../src/transports/legacy-channel.ts) | Wrapping an older outbound-only channel so the delivery worker sees one interface. |
