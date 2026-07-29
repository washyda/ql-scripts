import assert from "node:assert/strict";
import test from "node:test";

import { createHelloMessage } from "../scripts/hello_world";

test("creates the default hello message", () => {
  assert.equal(
    createHelloMessage(),
    "Hello, QingLong! TypeScript 脚本运行成功。",
  );
});

test("supports a custom name", () => {
  assert.equal(
    createHelloMessage("青龙"),
    "Hello, 青龙! TypeScript 脚本运行成功。",
  );
});
