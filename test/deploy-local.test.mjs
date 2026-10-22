import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deployLocal, deploymentPaths, installSnapshot, runNpm, runtimeFiles, sourceRoot, validateDestination } from "../scripts/deploy-local.mjs";

async function fixture(t) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "markdown deploy test ")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, "dirty worktree");
    const home = join(root, "user home");
    const copilotHome = join(root, "custom copilot home");
    await mkdir(join(source, "node_modules"), { recursive: true });
    for (const file of runtimeFiles) {
        await mkdir(resolve(source, file, ".."), { recursive: true });
        await writeFile(join(source, file), `worktree:${file}`);
    }
    await writeFile(join(source, "private.md"), "must not deploy");
    await mkdir(join(source, "artifacts"));
    await writeFile(join(source, "artifacts", "private.json"), "must not deploy");
    const calls = [];
    const logs = [];
    const options = {
        source, home, env: { COPILOT_HOME: copilotHome }, log: (line) => logs.push(line),
        npm: async (args, { cwd }) => {
            calls.push({ args, cwd });
            if (args[0] === "ci") {
                await mkdir(join(cwd, "node_modules"));
                await writeFile(join(cwd, "node_modules", "runtime.txt"), "production dependencies");
            }
        },
        verify: async (stage) => {
            for (const file of runtimeFiles) assert.equal(await readFile(join(stage, file), "utf8"), `worktree:${file}`);
        },
    };
    return { root, source, home, copilotHome, target: deploymentPaths(options).target, options, calls, logs };
}

test("resolves default and custom Copilot homes without using cwd for source", () => {
    assert.equal(deploymentPaths({ env: {}, home: resolve("user home") }).target, resolve("user home", ".copilot", "extensions", "markdown-comments"));
    assert.equal(deploymentPaths({ env: { COPILOT_HOME: resolve("custom home") } }).target, resolve("custom home", "extensions", "markdown-comments"));
    assert.equal(sourceRoot, resolve(import.meta.dirname, ".."));
});

test("deploys current worktree files and production dependencies using an allowlist", async (t) => {
    const f = await fixture(t);
    assert.equal(await deployLocal(f.options), f.target);
    assert.deepEqual(f.calls.map(({ args }) => args), [["run", "build"], ["test"], ["ci", "--omit=dev"]]);
    assert.equal(f.calls[0].cwd, f.source);
    assert.equal(await readFile(join(f.target, "extension.mjs"), "utf8"), "worktree:extension.mjs");
    assert.equal(await readFile(join(f.target, "markdown-reference.mjs"), "utf8"), "worktree:markdown-reference.mjs");
    assert.equal(await readFile(join(f.target, "node_modules", "runtime.txt"), "utf8"), "production dependencies");
    for (const file of ["private.md", "artifacts", "scripts"]) {
        await assert.rejects(readFile(join(f.target, file)), { code: "ENOENT" });
    }
    assert.deepEqual(await readdir(f.copilotHome), ["extensions"]);
    assert.match(f.logs.join("\n"), /Deployed snapshot:/);
});

test("redeploys feedback while preserving artifacts, locks, and unrelated installed files", async (t) => {
    const f = await fixture(t);
    await deployLocal(f.options);
    await mkdir(join(f.target, "artifacts", "document", "comment.lock"), { recursive: true });
    const saved = Buffer.from([0, 10, 255, 99]);
    await writeFile(join(f.target, "artifacts", "document", "comment.json"), saved);
    await writeFile(join(f.target, "feedback.json"), "custom installed feedback");
    await writeFile(join(f.target, "dist", "unrelated.txt"), "keep");
    await writeFile(join(f.target, "local-notes.txt"), "keep");
    await deployLocal(f.options);
    assert.deepEqual(await readFile(join(f.target, "artifacts", "document", "comment.json")), saved);
    assert.deepEqual(await readdir(join(f.target, "artifacts", "document", "comment.lock")), []);
    assert.equal(await readFile(join(f.target, "feedback.json"), "utf8"), "worktree:feedback.json");
    assert.equal(await readFile(join(f.target, "dist", "unrelated.txt"), "utf8"), "keep");
    assert.equal(await readFile(join(f.target, "local-notes.txt"), "utf8"), "keep");
});

for (const phase of ["build", "test", "ci", "verify"]) {
    test(`${phase} failure leaves the previous installation untouched and cleans up`, async (t) => {
        const f = await fixture(t);
        await deployLocal(f.options);
        await writeFile(join(f.target, "extension.mjs"), "previous version");
        const npm = f.options.npm;
        const options = {
            ...f.options,
            npm: async (args, context) => {
                if (args.includes(phase)) throw new Error(`${phase} failed`);
                await npm(args, context);
            },
            verify: phase === "verify" ? async () => { throw new Error("verify failed"); } : f.options.verify,
        };
        await assert.rejects(deployLocal(options), new RegExp(`${phase} failed`));
        assert.equal(await readFile(join(f.target, "extension.mjs"), "utf8"), "previous version");
        assert.deepEqual(await readdir(f.copilotHome), ["extensions"]);
    });
}

test("rejects missing source dependencies with actionable instructions", async (t) => {
    const f = await fixture(t);
    await rm(join(f.source, "node_modules"), { recursive: true });
    await assert.rejects(deployLocal(f.options), /Run npm ci --userconfig/);
    assert.equal(f.calls.length, 0);
});

test("missing runtime files stop staging without touching installed code", async (t) => {
    const f = await fixture(t);
    await deployLocal(f.options);
    await writeFile(join(f.target, "extension.mjs"), "previous version");
    await rm(join(f.source, "style.css"));
    await assert.rejects(deployLocal(f.options), { code: "ENOENT" });
    assert.equal(await readFile(join(f.target, "extension.mjs"), "utf8"), "previous version");
    assert.deepEqual(await readdir(f.copilotHome), ["extensions"]);
});

test("rejects concurrent deployment without removing someone else's lock", async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.copilotHome, ".markdown-comments-deploy.lock"), { recursive: true });
    await assert.rejects(deployLocal(f.options), /Another deployment is running/);
    assert.deepEqual(await readdir(f.copilotHome), [".markdown-comments-deploy.lock"]);
    assert.equal(f.calls.length, 0);
});

test("rejects overlapping destinations and non-directory targets", async (t) => {
    const f = await fixture(t);
    await assert.rejects(validateDestination(f.source, f.source), /must not overlap/);
    await assert.rejects(validateDestination(f.source, join(f.source, "nested")), /must not overlap/);
    await assert.rejects(validateDestination(f.source, f.root), /must not overlap/);
    await writeFile(join(f.root, "file"), "not a directory");
    await assert.rejects(validateDestination(f.source, join(f.root, "file")), /not a directory/);
});

test("rejects junctions or symlinks in destination and managed paths", async (t) => {
    const f = await fixture(t);
    const actual = join(f.root, "actual");
    await mkdir(actual);
    const linked = join(f.root, "linked");
    await symlink(actual, linked, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(validateDestination(f.source, join(linked, "extension")), /symbolic link or junction/);
    await mkdir(f.target, { recursive: true });
    await symlink(actual, join(f.target, "dist"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(validateDestination(f.source, f.target), /symbolic link or junction/);
});

test("supports a junction or symlink for Copilot home while guarding the extension destination", async (t) => {
    const f = await fixture(t);
    await mkdir(f.copilotHome);
    const linkedHome = join(f.root, "linked copilot home");
    await symlink(f.copilotHome, linkedHome, process.platform === "win32" ? "junction" : "dir");
    const options = { ...f.options, env: { COPILOT_HOME: linkedHome } };
    assert.equal(await deployLocal(options), f.target);
    assert.equal(await readFile(join(f.target, "extension.mjs"), "utf8"), "worktree:extension.mjs");
    const external = join(f.root, "external extension");
    await rename(f.target, external);
    await symlink(external, f.target, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(deployLocal(options), /symbolic link or junction/);
});

test("rolls back replacement failures, including already replaced files and dependencies", async (t) => {
    const f = await fixture(t);
    await deployLocal(f.options);
    await writeFile(join(f.target, "extension.mjs"), "previous extension");
    await writeFile(join(f.target, "feedback.json"), "previous feedback");
    await assert.rejects(deployLocal({
        ...f.options,
        install: (stage, target, backup) => installSnapshot(stage, target, backup, {
            move: async (from, to) => {
                if (from === join(stage, "node_modules")) throw new Error("simulated file lock");
                await rename(from, to);
            },
        }),
    }), /previous managed files restored: simulated file lock/);
    assert.equal(await readFile(join(f.target, "extension.mjs"), "utf8"), "previous extension");
    assert.equal(await readFile(join(f.target, "feedback.json"), "utf8"), "previous feedback");
    assert.equal(await readFile(join(f.target, "node_modules", "runtime.txt"), "utf8"), "production dependencies");
    assert.deepEqual(await readdir(f.copilotHome), ["extensions"]);
});

test("retains recovery files and lock when rollback fails", async (t) => {
    const f = await fixture(t);
    await deployLocal(f.options);
    await assert.rejects(deployLocal({
        ...f.options,
        install: (stage, target, backup) => installSnapshot(stage, target, backup, {
            move: async (from, to) => {
                if (from === join(stage, "server.mjs") || from === join(backup, "extension.mjs")) throw new Error("simulated lock");
                await rename(from, to);
            },
        }),
    }), /Deployment and rollback failed. Recovery files:/);
    const entries = await readdir(f.copilotHome);
    assert.ok(entries.includes(".markdown-comments-deploy.lock"));
    const workspace = entries.find((entry) => entry.startsWith(".markdown-comments-deploy-"));
    assert.equal(await readFile(join(f.copilotHome, workspace, "previous", "extension.mjs"), "utf8"), "worktree:extension.mjs");
    assert.match(f.logs.join("\n"), /Recovery required/);
});

test("first-install replacement failure removes newly installed managed files", async (t) => {
    const f = await fixture(t);
    await assert.rejects(deployLocal({
        ...f.options,
        install: (stage, target, backup) => installSnapshot(stage, target, backup, {
            move: async (from, to) => {
                if (from === join(stage, "server.mjs")) throw new Error("first install failed");
                await rename(from, to);
            },
        }),
    }), /previous managed files restored: first install failed/);
    for (const file of runtimeFiles) {
        await assert.rejects(readFile(join(f.target, file)), { code: "ENOENT" });
    }
    assert.deepEqual(await readdir(f.copilotHome), ["extensions"]);
});

test("reports subprocess failure and launch errors without a shell", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "markdown npm test "));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cli = join(root, "fake npm.mjs");
    await writeFile(cli, 'console.log("fixture npm failure"); process.exit(7);');
    await assert.rejects(runNpm(["test"], { cwd: root, env: { ...process.env, npm_execpath: cli } }), /npm test failed \(exit 7\)/);
    await assert.rejects(runNpm(["test"], { cwd: join(root, "missing"), env: process.env }), /Could not run npm test/);
});

test("passes user-profile npm configuration to subprocesses", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "markdown npm config "));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cli = join(root, "fake npm.mjs");
    await writeFile(cli, 'import { writeFileSync } from "node:fs"; writeFileSync("config.txt", process.env.npm_config_userconfig);');
    await runNpm(["test"], { cwd: root, home: root, env: { ...process.env, npm_execpath: cli } });
    assert.equal(await readFile(join(root, "config.txt"), "utf8"), join(root, ".npmrc"));
});
