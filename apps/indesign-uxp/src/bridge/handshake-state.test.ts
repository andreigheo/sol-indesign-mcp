import { describe, expect, it } from "vitest";
import { BridgeHandshakeState } from "./handshake-state";

describe("bridge handshake sequencing", () => {
  it("requires challenge then authentication before accepting authenticated", () => {
    const state = new BridgeHandshakeState();
    state.begin();
    expect(() => state.acceptAuthenticatedEvent()).toThrow(/before challenge-response/u);
    state.acceptChallenge();
    state.acceptAuthenticatedEvent();
    expect(state.authenticated).toBe(true);
  });

  it("accepts a bounded server retry challenge after a rejected authentication", () => {
    const state = new BridgeHandshakeState();
    state.begin();
    state.acceptChallenge();
    expect(() => state.acceptChallenge()).not.toThrow();
    state.acceptAuthenticatedEvent();
    expect(state.authenticated).toBe(true);
    expect(() => state.acceptChallenge()).toThrow(/out of sequence/u);
  });

  it("rejects more than three challenges in one handshake and resets the bound", () => {
    const state = new BridgeHandshakeState();
    state.begin();
    state.acceptChallenge();
    state.acceptChallenge();
    state.acceptChallenge();
    expect(() => state.acceptChallenge()).toThrow(/out of sequence/u);

    state.reset();
    state.begin();
    expect(() => state.acceptChallenge()).not.toThrow();
  });
});
