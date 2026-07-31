import assert from "node:assert/strict";
import test from "node:test";

import { randomDelayBetween } from "../src/core/task";

test("randomDelayBetween stays within its inclusive range", () => {
  assert.equal(
    randomDelayBetween(1_000, 30_000, () => 0),
    1_000,
  );
  assert.equal(
    randomDelayBetween(1_000, 30_000, () => 0.999999),
    30_000,
  );
  assert.throws(() => randomDelayBetween(30_000, 1_000), RangeError);
});
