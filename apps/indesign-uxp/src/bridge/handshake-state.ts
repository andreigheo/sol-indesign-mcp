import { SafeBridgeError } from "../core/errors";

export type HandshakePhase = "idle" | "awaiting_challenge" | "authentication_sent" | "authenticated";

export class BridgeHandshakeState {
  #phase: HandshakePhase = "idle";
  #challengeCount = 0;

  get phase(): HandshakePhase {
    return this.#phase;
  }

  get authenticated(): boolean {
    return this.#phase === "authenticated";
  }

  begin(): void {
    this.#phase = "awaiting_challenge";
    this.#challengeCount = 0;
  }

  acceptChallenge(): void {
    if (
      (this.#phase !== "awaiting_challenge" && this.#phase !== "authentication_sent")
      || this.#challengeCount >= 3
    ) {
      throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", "The bridge authentication challenge arrived out of sequence.");
    }
    this.#challengeCount += 1;
    this.#phase = "authentication_sent";
  }

  acceptAuthenticatedEvent(): void {
    if (this.#phase !== "authentication_sent") {
      throw new SafeBridgeError("BRIDGE_PROTOCOL_ERROR", "The bridge authenticated event arrived before challenge-response completed.");
    }
    this.#phase = "authenticated";
  }

  reset(): void {
    this.#phase = "idle";
    this.#challengeCount = 0;
  }
}
