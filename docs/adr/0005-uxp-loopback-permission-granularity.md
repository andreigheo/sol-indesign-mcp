# ADR 0005: Use port-qualified localhost permissions for an IPv4-only bridge

- Status: Accepted
- Date: 2026-07-16
- Decision owners: Sol InDesign MCP maintainers

## Context

The Node bridge is required to listen only on `127.0.0.1:32145`. The original UXP manifest and transport URLs also used the literal IPv4 address. Clean UDT unload/load probes in stable InDesign 21.4.1 with UXP 9.3 rejected both WebSocket and HTTP requests before they reached the server with `Permission denied ... Manifest entry not found`, regardless of whether the IP-literal manifest selector contained a port or trailing slash.

An audit of the installed UXP runtime showed that its manifest-domain parser discards IP-literal hosts before permission matching and explicitly accepts `localhost`. The same installed InDesign distribution contains a first-party manifest with port-qualified `http://localhost:<port>` selectors. Runtime matching retains the scheme and numeric port, strips resource paths, and treats an omitted port as any port.

Native Windows probes confirmed that both `http://localhost:32145` and `ws://localhost:32145` reach the bridge while the server remains bound only to IPv4 `127.0.0.1`. Adobe's current [InDesign network recipe](https://developer.adobe.com/indesign/uxp/resources/recipes/network/) and [manifest reference](https://developer.adobe.com/indesign/uxp/plugins/concepts/manifest/) require separate scheme-specific network domains but do not document the installed runtime's IP-literal filtering.

## Decision

Declare exactly these two UXP network domains:

```text
ws://localhost:32145
http://localhost:32145
```

Use matching compile-time transport endpoints:

```text
ws://localhost:32145/bridge
http://localhost:32145/bridge/http
```

This hostname substitution exists only at the trusted UXP client boundary. The Node server still binds exclusively to `127.0.0.1:32145`; it does not listen on IPv6, a LAN interface, or a hostname-selected interface. Protocol negotiation and HMAC challenge-response authentication remain mandatory before operational frames.

Additional controls are mandatory:

- no MCP argument, bridge frame, environment value, workspace setting, or plugin field can supply or alter a transport URL;
- the manifest must contain the exact scheme-and-port pair above, never a no-port selector, path selector, wildcard, external host, or `all`;
- bundle tests reject IP-literal URLs, other localhost ports, other localhost paths, TLS schemes, and new network destinations;
- the server continues to enforce its literal IPv4 bind, frame limits, authentication limits, and single-active-plugin rule;
- native Windows verification must prove that `localhost` resolves to the IPv4-only listener for both HTTP and WebSocket before a supported-host claim.

Any additional destination, configurable URL, scheme, hostname, wildcard, or port requires a new accepted ADR and threat-model review.

## Consequences

### Positive

- The supported installed UXP runtime retains and matches both required permissions.
- The manifest is restricted to the one production port instead of granting every loopback port.
- The server's literal IPv4 exposure and authentication boundary are unchanged.
- Static transport constants remain simple to audit and test.

### Negative

- The plugin URL uses a hostname while the server binds a literal address. The supported native Windows environment must continue to resolve and fall back to IPv4 correctly.
- A hostile local resolver configuration could make `localhost` resolution fail. It cannot make the server accept traffic on another interface because the listener remains bound to `127.0.0.1`.
- The runtime's IP-literal filtering and exact matcher behavior are installed-host evidence rather than a documented Adobe contract, so host upgrades require a fresh compatibility probe.

## Rejected alternatives

### IP-literal manifest entries

The supported runtime discards them before matching. Adding ports, slashes, or paths does not change that behavior.

### No-port localhost selectors

They work but authorize every localhost port for the corresponding scheme and are broader than necessary.

### Bare `localhost:32145`

It can match more than one scheme. Separate `ws` and `http` entries make the intended API surfaces explicit.

### Paths in manifest selectors

The runtime strips resource paths during domain parsing, so path-bearing entries add no enforcement and create false precision. Paths remain enforced by fixed bundle constants and server routing.

### Wildcard or `all` network permission

These permit destinations outside the bridge boundary and are unnecessary.

### External relay or TLS termination

A relay adds a new service, credential, data path, and distribution burden without improving local document control.

## Validation

- Manifest tests accept only the two port-qualified localhost entries and reject IP literals, omitted or different ports, paths, TLS, wildcards, external domains, and `all`.
- WebSocket and HTTP transport tests assert every fixed URL, method, encoded client ID, retry bound, and the three-WebSocket-failure fallback threshold.
- Bundle and CCX validation reject every unapproved loopback URL and inspect all packaged files.
- `pnpm sync:uxp-host` verifies source, dist, canonical CCX, and the installed External bundle byte-for-byte before the one cold UDT load.
- A clean UDT unload/load in stable InDesign must authenticate through WebSocket and then through a sequential forced HTTP-fallback probe before this change is recorded as host-passed.
