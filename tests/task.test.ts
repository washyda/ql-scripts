import assert from "node:assert/strict";
import test from "node:test";

import { randomDelay } from "../src/core/task";

test("randomDelay stays within the requested inclusive range", () => {
  assert.equal(
    randomDelay(300_000, () => 0),
    0,
  );
  assert.equal(
    randomDelay(300_000, () => 0.999999),
    300_000,
  );
  assert.throws(() => randomDelay(-1), RangeError);
});
