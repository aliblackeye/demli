/**
 * Source-level invariants for the mobile call↔voice wiring (call-UX plan K2).
 *
 * WHY a source test: the connectivity fixes themselves live in
 * `@demli/client-core` and are covered there behaviourally
 * (`call-connectivity.test.ts`, `call-voice-bridge.test.ts`). What no test there
 * can see is THIS app failing to CALL them — which is exactly what happened: the
 * shared fixes landed, desktop wired them, mobile did not, and the phone silently
 * kept the broken behaviour (a peer accepts and the call still never connects;
 * the only escape is leaving the room). vitest here is node-only "pure logic" by
 * policy — there is no RN harness that could import these modules — so the four
 * seams are pinned as source invariants instead of being left unguarded.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = fileURLToPath(import.meta.url); // …/src/stores/__tests__/<this file>
const MOBILE_SRC = join(HERE, "..", "..", ".."); // …/src

function read(relative: string): string {
  return readFileSync(join(MOBILE_SRC, relative), "utf8");
}

const CALL_STORE = read("stores/call-store.ts");
const CONNECTION = read("realtime/connection.ts");

describe("mobile call wiring (K2)", () => {
  it("resyncs the active call when the socket comes BACK (K2.2)", () => {
    // `call.accepted` is fan-out with no queue and no replay: a phone that blinked
    // (wifi→data, doze, gateway restart) used to lose the answer forever.
    expect(CONNECTION).toContain('resyncActiveCall("reconnect")');
    // …and only on a RE-connect: the first handshake of a session has nothing to
    // heal, and firing there would hit the endpoint on every cold start.
    const handshake = CONNECTION.slice(0, CONNECTION.indexOf('resyncActiveCall("reconnect")'));
    expect(handshake.lastIndexOf("if (hadHandshake)")).toBeGreaterThan(
      handshake.lastIndexOf("hadHandshake = true"),
    );
  });

  it("bridges media failures back to the call FSM through the SHARED decision (K2.4)", () => {
    expect(CALL_STORE).toContain("watchCallMedia({");
    expect(CALL_STORE).toContain("getController: () => controller");
    // The exceptions (`session_replaced`/`alone`, and a `pending` control action)
    // live inside the shared decision — this app must not re-implement any of it.
    expect(CALL_STORE).not.toContain("reportMediaFailure()");
  });

  it("builds the engine seam from the shared adapter — `leaving` wait + isConnectedTo (K2.3/K2.8)", () => {
    expect(CALL_STORE).toContain("createCallEngineAdapter({");
    // The old hand-rolled adapter: leave-if-live and nothing else. It threw
    // InvalidVoiceCommandError from `leaving` and answered no `isConnectedTo`, so
    // the controller could not tell a real `active` call from a media-less one.
    expect(CALL_STORE).not.toContain('status === "connected" || status === "joining"');
  });

  it("logs the one call/voice diagnostic pair on every FSM transition (K2.7)", () => {
    expect(CALL_STORE).toContain("onTransition: logCallTransition");
    expect(CALL_STORE).toContain("getVoiceStatus: () => voiceEngine.getState().status");
    expect(CALL_STORE).toContain("voice=${t.voiceStatus ?? \"?\"}");
  });
});
