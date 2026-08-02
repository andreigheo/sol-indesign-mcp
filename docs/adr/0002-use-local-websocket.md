# ADR 0002: Use an authenticated loopback WebSocket bridge

- Status: Accepted
- Date: 2026-07-14
- Decision owners: Sol InDesign MCP maintainers

## Context

Codex starts the MCP server as a child process over STDIO, while the InDesign UXP plugin runs in another application process. The plugin cannot share that STDIO stream and must initiate communication through a transport available to UXP.

The transport must be local, low-latency, bidirectional, bounded, authenticated, reconnectable, and compatible with a single active plugin. It must not broaden the UXP manifest to arbitrary network access.

Although the endpoint is loopback, any process under the local account may try to connect. Loopback location alone is not authentication. UXP runtime support for plain `ws://` load sessions also requires a narrow fallback strategy.

## Decision

The Node MCP process owns a bridge server bound only to:

```text
127.0.0.1:32145
```

WebSocket is the primary transport. After three load-session WebSocket failures, the plugin may switch to HTTP long polling on the exact same host and port. Both transports implement a shared `BridgeTransport` interface and carry the same versioned JSON frames, limits, authentication, request IDs, trace IDs, deadlines, and errors.

The protocol defines `BridgeHello`, `BridgeChallenge`, `BridgeAuthentication`, `BridgeRequest`, `BridgeResponse`, `BridgeEvent`, and `BridgeError`. The selected version is `sol-indesign-bridge/1`.

Authentication is challenge-response:

1. The plugin advertises supported protocol versions and capabilities.
2. The server creates a socket/session-bound random 32-byte nonce that expires after 15 seconds.
3. The plugin computes `HMAC-SHA256(key = decoded shared token, message = UTF-8 nonce)` and sends only the base64url digest plus session ID.
4. The server validates the one-time nonce and uses a timing-safe comparison.
5. Only then may the connection become the single active plugin.

Unauthenticated operational frames close the connection. The server permits at most three pending authentication attempts, three failed attempts per connection, and ten failures per minute globally. A new connection cannot displace a healthy active plugin and may replace it only after the current connection is stale.

Frames are capped at 8 MiB. The connection uses a 10-second heartbeat and a 30-second stale threshold. Reconnection uses jittered exponential delays bounded from 500 ms to 15 seconds. Request deadlines and cancellation remove queued work before it starts when possible; an active synchronous InDesign call is reported as non-interruptible rather than falsely cancelled.

The server endpoint remains fixed to the exact IPv4 loopback address and port above. InDesign UXP 9.3 discards IP-literal manifest domains, so the trusted plugin uses the narrowest retained origins and matching transport URLs: `ws://localhost:32145` and `http://localhost:32145`. It must not use an omitted/different port, wildcard, `all`, or external domain. ADR 0005 records this runtime-driven client/server hostname distinction and its compensating controls.

## Consequences

### Positive

- The plugin initiates a transport supported by its runtime and receives push requests with low overhead.
- Binding is not exposed to the LAN or internet.
- Identical framing and authentication keep HTTP polling from becoming a weaker fallback.
- A mock UXP client can exercise the real Node bridge in contract and end-to-end tests.
- Heartbeat, stale detection, and one-active-plugin semantics make lifecycle failures observable.

### Negative

- Another local process can reach the listening socket and must be treated as hostile until authentication completes.
- A fixed port can conflict with another process; `pnpm doctor` must detect this without taking over the port.
- Some installed UXP runtimes may reject plain WebSocket loopback despite the manifest declaration.
- Polling adds latency and request bookkeeping when fallback is active.
- A server restart drops the bridge and requires the plugin to authenticate again.

## Rejected alternatives

### Unauthenticated loopback socket

Local origin is not proof of plugin identity. This would let another local process invoke document operations.

### Broad HTTP API

A conventional unauthenticated REST service creates a larger request surface and provides no benefit over the shared bridge protocol.

### Remote WebSocket service

Remote transport would expose document metadata and operations outside the machine, require external network permissions, and complicate credential management.

### File-based request queue

Polling files introduces race conditions, stale work, filesystem permissions, and additional sensitive artifacts. It also conflicts with the one-authorized-workspace model.

### Plugin-hosted server

The UXP panel is designed as a client and should not expose a listener. The Node process owns lifecycle, MCP routing, token resolution, and audit logging.

## Validation

- Contract tests cover the full handshake, replay/expiry/failure cases, one-active-client policy, message limit, heartbeats, reconnect behavior, deadlines, and HTTP fallback.
- A startup test ensures the bind address is exactly `127.0.0.1`.
- Manifest tests ensure only both approved port-qualified localhost origins are declared; transport tests independently enforce port 32145 and the exact bridge paths, while server tests enforce the literal IPv4 bind.
- Real UXP WebSocket authentication and authenticated HTTP fallback, including operational requests over both transports, were observed in InDesign 21.4.1 / UXP 9.3. The final HTTP-fallback grouping and human-observed one-step Undo proof passed on 2026-07-16.
