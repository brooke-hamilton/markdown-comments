import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildRelease, extensionPath, pluginVersion } from "../scripts/build-release.mjs";
import { sourceRoot } from "../scripts/deploy-local.mjs";

const commit = "1234567890abcdef1234567890abcdef12345678";

test("release versions identify the source commit and reject invalid inputs", () => {
    assert.equal(pluginVersion("0.1.0", commit), "0.1.0+1234567");
    for (const version of ["01.0.0", "1", "1.0.0+old", "1.0.0-beta"]) {
        assert.throws(() => pluginVersion(version, commit), /Release requires/);
    }
    assert.throws(() => pluginVersion("0.1.0", "HEAD"), /full source commit SHA/);
});

test("builds a discoverable, self-contained plugin that opens a document without npm dependencies", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "markdown plugin test "));
    t.after(() => rm(root, { recursive: true, force: true }));
    const outputRoot = join(root, "plugin");
    const extension = await buildRelease({ outputRoot, sourceCommit: commit });
    assert.equal(extension, join(outputRoot, extensionPath));
    const plugin = JSON.parse(await readFile(join(outputRoot, "plugin.json"), "utf8"));
    const pkg = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
    assert.equal(plugin.name, "markdown-comments");
    assert.equal(plugin.version, `${pkg.version}+1234567`);
    assert.deepEqual(plugin.extensions, [".github/extensions"]);
    const marketplace = JSON.parse(await readFile(join(sourceRoot, ".github", "plugin", "marketplace.json"), "utf8"));
    assert.equal(marketplace.name, "markdown-comments-plugins");
    assert.deepEqual(marketplace.plugins[0].source, {
        source: "github", repo: "brooke-hamilton/markdown-comments", ref: "dist",
    });
    const localMarketplace = JSON.parse(await readFile(join(outputRoot, ".github", "plugin", "marketplace.json"), "utf8"));
    assert.equal(localMarketplace.name, marketplace.name);
    assert.equal(localMarketplace.plugins[0].source, "./");
    assert.equal(localMarketplace.plugins[0].version, plugin.version);
    const manifest = JSON.parse(await readFile(join(extension, "copilot-extension.json"), "utf8"));
    assert.equal(manifest.name, plugin.name);
    const files = (await readdir(outputRoot, { recursive: true })).map((file) => file.replaceAll("\\", "/"));
    for (const name of ["node_modules", "artifacts", "test", "scripts", "package-lock.json", "ui.mjs", "editor.mjs"]) {
        assert.ok(!files.some((file) => file.split("/").includes(name)), `must not ship ${name}`);
    }
    const notices = await readFile(join(extension, "THIRD-PARTY-NOTICES.txt"), "utf8");
    assert.match(notices, /markdown-it@/);
    assert.match(notices, /mermaid@/);
    assert.match(notices, /Permission is hereby granted/);
    await assert.rejects(buildRelease({ outputRoot, sourceCommit: commit }), { code: "EEXIST" });
    assert.equal(await readFile(join(outputRoot, "plugin.json"), "utf8"), `${JSON.stringify(plugin, null, 2)}\n`);

    // Only the host-provided extension SDK is stubbed; all application dependencies must be bundled.
    const sdk = join(root, "node_modules", "@github", "copilot-sdk");
    await mkdir(sdk, { recursive: true });
    await writeFile(join(sdk, "package.json"), JSON.stringify({
        name: "@github/copilot-sdk", type: "module", exports: { "./extension": "./extension.mjs" },
    }));
    await writeFile(join(sdk, "extension.mjs"), `
        export class CanvasError extends Error {}
        export const createCanvas = (canvas) => canvas;
        export const joinSession = async (options) => {
            globalThis.registration = options;
            return { send: async () => {} };
        };
    `);
    const script = `
        import assert from "node:assert/strict";
        const { renderDocument } = await import(${JSON.stringify(pathToFileURL(join(extension, "review.mjs")).href)});
        assert.match(renderDocument("# Bundled runtime"), /<h1.*>Bundled runtime<\\/h1>/);
        await import(${JSON.stringify(pathToFileURL(join(extension, "extension.mjs")).href)});
        const canvas = globalThis.registration.canvases[0];
        assert.equal(canvas.id, "markdown-comments");
        assert.equal(globalThis.registration.tools[0].name, "markdown_comments_resolve_comment");
        const ctx = { instanceId: "release-test", input: { path: ${JSON.stringify(join(extension, "examples", "welcome.md"))} } };
        try {
            const opened = await canvas.open(ctx);
            for (const route of ["", "app.js", "app.css", "style.css", "state"]) {
                const response = await fetch(opened.url + route);
                assert.equal(response.status, 200, route);
                assert.ok((await response.text()).length > 0, route);
            }
            assert.deepEqual(await canvas.actions.find((action) => action.name === "list_comments").handler(ctx), []);
        } finally {
            await canvas.onClose(ctx);
        }
    `;
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
        cwd: root, env: { ...process.env, NODE_PATH: "" }, timeout: 30_000,
    });
});
