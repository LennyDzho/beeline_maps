import test from "node:test";
import assert from "node:assert/strict";
import { instantToRegionalTime, regionalTimeToInstant, scheduleTimeToInstant } from "../src/regional-time.js";

test("regional schedule represents the same instant regardless of the host timezone", () => {
  const original = process.env.TZ;
  try {
    for (const host of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
      process.env.TZ = host;
      assert.equal(regionalTimeToInstant("2026-08-17T09:00", "Europe/Moscow"), "2026-08-17T06:00:00.000Z");
      assert.equal(regionalTimeToInstant("2026-08-17T09:00", "Asia/Yekaterinburg"), "2026-08-17T04:00:00.000Z");
      assert.equal(instantToRegionalTime("2026-08-17T23:00:00Z", "Asia/Kamchatka"), "2026-08-18T11:00:00");
      assert.equal(scheduleTimeToInstant("2026-08-17T09:00+05:00", "Europe/Moscow"), "2026-08-17T04:00:00.000Z");
    }
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});

test("invalid dates, missing zones and ambiguous daylight-saving times cannot move an appointment silently", () => {
  for (const value of ["2026-02-30T09:00", "2026-08-17T24:00", "2026-08-17", "invalid"]) {
    assert.throws(() => regionalTimeToInstant(value, "Europe/Moscow"), RangeError);
  }
  assert.throws(() => regionalTimeToInstant("2026-08-17T09:00", "Invalid/Zone"), RangeError);
  assert.throws(() => regionalTimeToInstant("2026-03-08T02:30", "America/New_York"), RangeError);
  assert.throws(() => regionalTimeToInstant("2026-11-01T01:30", "America/New_York"), RangeError);
  assert.throws(() => instantToRegionalTime("2026-08-17T09:00", "Europe/Moscow"), RangeError);
});
