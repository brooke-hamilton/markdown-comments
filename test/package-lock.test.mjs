import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the lockfile pins packages without embedding a developer's npm registry", async () => {
    const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
    const config = await readFile(new URL("../.npmrc", import.meta.url), "utf8");
    assert.match(config, /^omit-lockfile-registry-resolved=true$/m);
    for (const [path, entry] of Object.entries(lock.packages)) {
        if (!path) continue;
        assert.ok(entry.version, `${path} must pin a version`);
        assert.ok(entry.integrity, `${path} must retain its integrity hash`);
        assert.equal(entry.resolved, undefined, `${path} must use the installer's configured registry`);
    }
});
