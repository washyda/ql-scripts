import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const scriptsDirectory = join(process.cwd(), "scripts");

test("every task starts with QingLong line-comment metadata", () => {
  for (const filename of readdirSync(scriptsDirectory)) {
    if (!filename.endsWith(".ts")) continue;
    const header = readFileSync(join(scriptsDirectory, filename), "utf8")
      .split("\n")
      .slice(0, 4)
      .join("\n");

    assert.match(header, /^\/\/ @name\s+\S.+$/mu, filename);
    assert.match(header, /^\/\/ @description\s+\S.+$/mu, filename);
    assert.match(header, /^\/\/ @cron\s+\S.+$/mu, filename);
    assert.match(header, /script-path=scripts\/[a-z0-9_]+\.ts/u, filename);

    const source = readFileSync(join(scriptsDirectory, filename), "utf8");
    assert.match(
      source,
      /^\/\/ name:\s*"[^"]+"\s*$/mu,
      `${filename} 缺少无尾逗号的名称兼容行`,
    );
  }
});
