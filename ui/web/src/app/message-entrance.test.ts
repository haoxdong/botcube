import { describe, expect, it } from "vitest";
import { MessageEntrances } from "./message-entrance";

describe("message origins", () => {
  it("keeps the entire initial snapshot and later reconciled snapshots out of arrival motion", () => {
    const entrances = new MessageEntrances([{ id: "paged-history" }, { id: "visible-history" }]);
    expect(entrances.entrance("paged-history")).toBe("settled");
    expect(entrances.entrance("visible-history")).toBe("settled");
    entrances.seedTranscript([{ id: "restored-after-mount" }]);
    expect(entrances.entrance("restored-after-mount")).toBe("settled");
    expect(entrances.entrance("live" )).toBe("arrival");
  });

  it("does not treat a presented logical row's remount as another arrival", () => {
    const entrances = new MessageEntrances([]);
    expect(entrances.entrance("live")).toBe("arrival");
    entrances.presentedRow("live");
    expect(entrances.entrance("live")).toBe("settled");
    expect(entrances.fromTranscript("live")).toBe(false);
    entrances.seedTranscript([{ id: "live" }]);
    expect(entrances.fromTranscript("live")).toBe(true);
  });

  it("distinguishes an Artifact update in place from a replacement in another answer root", () => {
    const entrances = new MessageEntrances([]);
    const first = Symbol();
    const next = Symbol();
    const card = JSON.stringify(["turn", "artifact"]);
    expect(entrances.replaces([card], first)).toBe(false);
    entrances.presentedArtifacts([card], first);
    expect(entrances.replaces([card], first)).toBe(false);
    expect(entrances.replaces([card], next)).toBe(true);
    expect(entrances.replaces([JSON.stringify(["another-turn", "artifact"])], next)).toBe(false);
    entrances.presentedArtifacts([card], next);
    expect(entrances.replaces([card], next)).toBe(false);
  });

  it("leaves the first content arrival available when only its containing row was presented", () => {
    const entrances = new MessageEntrances([]);
    entrances.presentedRow("message");
    expect(entrances.entrance("message")).toBe("settled");
    expect(entrances.messageEntrance("message")).toBe("arrival");
    entrances.presentedMessage("message");
    expect(entrances.messageEntrance("message")).toBe("settled");
    expect(entrances.messageEntrance("another-message")).toBe("arrival");
  });
});
