import { describe, expect, it } from "vitest";
import { parsePdu } from "./room-pdu";

describe("parsePdu", () => {
  it("classifies hs / env / frame / ack / null", () => {
    expect(parsePdu('{"kind":"hs","v":1,"type":"hello","payload":{}}')).toEqual({
      kind: "hs",
      hs: { kind: "hs", v: 1, type: "hello", payload: {} },
    });
    expect(parsePdu('{"tv":1,"kid":"k","n":"AA","c":"BB","mid":"f:1"}')?.kind).toBe("env");
    expect(parsePdu('{"v":1,"roomId":"r","seq":1,"type":"join","payload":{}}')?.kind).toBe(
      "frame",
    );
    expect(parsePdu('{"kind":"ack","tv":1,"kid":"k","upto":3}')).toEqual({
      kind: "ack",
      tv: 1,
      kid: "k",
      upto: 3,
    });
    expect(parsePdu('{"v":2,"roomId":"r","type":"join"}')).toBeNull();
  });

  it("returns null for broken JSON", () => {
    expect(parsePdu("{not json")).toBeNull();
  });

  it("rejects handshake with wrong version", () => {
    expect(parsePdu('{"kind":"hs","v":2,"type":"hello","payload":{}}')).toBeNull();
  });
});
