import { describe, expect, it } from "vitest";
import { validateRoomMentions } from "./room-mentions";

const seats = [{ id: "dev", name: "Dev" }, { id: "human", name: "小林" }];
const validate = (text: string, records: unknown) =>
  validateRoomMentions(text, records, seats);

describe("explicit room mentions", () => {
  it("accepts a selected identity only while name and trailing space match", () => {
    expect(validate("@Dev work", [{ seatId: "dev", start: 0, end: 4 }]))
      .toEqual([{ seatId: "dev", start: 0, end: 4 }]);
    expect(validate("@小林 ", [{ seatId: "human", start: 0, end: 3 }]))
      .toEqual([{ seatId: "human", start: 0, end: 3 }]);
  });
  it("does not infer pasted text, filenames or unselected names", () => {
    for (const text of ["@Dev work", "[Attached: @Dev.txt]", "@Dev "]) {
      expect(validate(text, [])).toEqual([]);
    }
  });
  it("invalidates removed spaces, changed names, stale IDs and malformed ranges", () => {
    for (const text of ["@Dev", "@Dev\nwork", "@DevX work", "@dev work"]) {
      expect(validate(text, [{ seatId: "dev", start: 0, end: 4 }])).toEqual([]);
    }
    for (const record of [null, { seatId: "ghost", start: 0, end: 4 }, { seatId: "dev", start: -1, end: 4 }, { seatId: "dev", start: 0, end: 3.5 }]) {
      expect(validate("@Dev work", [record])).toEqual([]);
    }
  });
  it("preserves valid separate occurrences and rejects duplicate ranges", () => {
    const first = { seatId: "dev", start: 0, end: 4 };
    const second = { seatId: "dev", start: 5, end: 9 };
    expect(validate("@Dev @Dev work", [first, first, second])).toEqual([first, second]);
  });
});
