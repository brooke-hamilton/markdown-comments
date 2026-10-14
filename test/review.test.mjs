import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewStore, renderDocument, validateConfig } from "../review.mjs";
import { startServer } from "../server.mjs";

async function fixture(t, send = async () => "message-1") {
    const root = await mkdtemp(join(tmpdir(), "markdown-comments-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "doc.md");
    const source = "# Title\n\nA **formatted** passage.\n\nA repeated passage.\n";
    await writeFile(path, source);
    const configPath = join(root, "feedback.json");
    await writeFile(configPath, JSON.stringify({ prompts: [{ id: "rewrite", label: "Rewrite", prompt: "Rewrite clearly." }] }));
    const store = new ReviewStore({ send, storageRoot: join(root, "comments"), configPath });
    const state = await store.state(path);
    const input = { revision: state.revision, quote: "formatted", startLine: 2, endLine: 3, startOffset: 9, endOffset: 18, prompt: "Make this clearer." };
    return { root, path, source, store, state, input, configPath };
}

test("renders source mappings, Markdown, tables, indented code, and Mermaid without executable HTML", () => {
    const html = renderDocument("# Heading\n\nSome **bold** words.\n\n    code\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n<script>alert(1)</script>\n\n![private](https://example.com/image.png)");
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /data-start-line="2" data-end-line="3"/);
    assert.match(html, /data-start-line="4" data-end-line="5"/);
    assert.match(html, /class="mermaid-source"/);
    assert.doesNotMatch(html, /<script>|<img/);
});

test("validates editable configuration, including duplicate ids", () => {
    assert.equal(validateConfig({ prompts: [] }).length, 0);
    assert.throws(() => validateConfig({ prompts: [{ id: "a", label: "", prompt: "x" }] }));
    assert.throws(() => validateConfig({ prompts: [{ id: "a", label: "A", prompt: "x" }, { id: "a", label: "B", prompt: "y" }] }));
});

test("persists contextual custom feedback by canonical document identity", async (t) => {
    const sent = [];
    const f = await fixture(t, async (prompt) => { sent.push(prompt); return "message-7"; });
    const comment = await f.store.submit(f.path, f.input);
    assert.equal(comment.status, "sent");
    assert.equal(comment.messageId, "message-7");
    assert.match(sent[0], /selectedQuote/);
    assert.match(sent[0], /A \*\*formatted\*\* passage/);
    assert.match(sent[0], /Make this clearer/);
    assert.match(sent[0], /"first": 3/);
    const restarted = new ReviewStore({ send: async () => "", storageRoot: join(f.root, "comments"), configPath: f.configPath });
    assert.equal((await restarted.state(f.path)).comments[0].id, comment.id);
    assert.equal(await readFile(f.path, "utf8"), f.source);
});

test("uses configured presets and reloads configuration from disk", async (t) => {
    const f = await fixture(t);
    const comment = await f.store.submit(f.path, { ...f.input, promptId: "rewrite" });
    assert.equal(comment.instruction, "Rewrite clearly.");
    await writeFile(f.configPath, JSON.stringify({ prompts: [{ id: "new", label: "New", prompt: "New instruction" }] }));
    assert.equal((await f.store.state(f.path)).prompts[0].id, "new");
    await assert.rejects(f.store.submit(f.path, { ...f.input, promptId: "rewrite" }), /no longer exists/);
});

test("rejects stale revisions and invalid selections without dispatch", async (t) => {
    let count = 0;
    const f = await fixture(t, async () => { count++; return "sent"; });
    for (const input of [{ ...f.input, quote: "" }, { ...f.input, endLine: 99 }, { ...f.input, prompt: " " }, { ...f.input, startOffset: -1 }]) {
        await assert.rejects(f.store.submit(f.path, input));
    }
    await writeFile(f.path, "Changed");
    await assert.rejects(f.store.submit(f.path, f.input), /document changed/);
    assert.equal(count, 0);
});

test("saves delivery failures rather than pretending the model accepted feedback", async (t) => {
    const f = await fixture(t, async () => { throw new Error("Disconnected"); });
    await assert.rejects(f.store.submit(f.path, f.input), /Disconnected/);
    const comments = await f.store.comments(f.path);
    assert.equal(comments[0].status, "failed");
    assert.equal(comments[0].error, "Disconnected");
});

test("serializes concurrent comment writes and persists resolve/reopen", async (t) => {
    const f = await fixture(t);
    await Promise.all([f.store.submit(f.path, f.input), f.store.submit(f.path, f.input)]);
    const comments = await f.store.comments(f.path);
    assert.equal(comments.length, 2);
    await f.store.resolve(f.path, { id: comments[0].id, resolved: true });
    assert.equal((await f.store.comments(f.path))[0].resolved, true);
    await f.store.resolve(f.path, { id: comments[0].id, resolved: false });
    assert.equal((await f.store.comments(f.path))[0].resolved, false);
});

test("independent session providers do not overwrite each other's comments", async (t) => {
    const f = await fixture(t);
    const other = new ReviewStore({ send: async () => "other-session", storageRoot: join(f.root, "comments"), configPath: f.configPath });
    await Promise.all([f.store.submit(f.path, f.input), other.submit(f.path, f.input)]);
    assert.equal((await f.store.comments(f.path)).length, 2);
});

test("includes rendered offsets and nearby context to distinguish repeated words", async (t) => {
    let prompt;
    const f = await fixture(t, async (value) => { prompt = value; return "message"; });
    const anchor = { prefix: "A ", suffix: " passage.", startBlockOffset: 2, endBlockOffset: 11 };
    await f.store.submit(f.path, { ...f.input, anchor });
    assert.match(prompt, /"startBlockOffset": 2/);
    assert.match(prompt, /"suffix": " passage."/);
    assert.deepEqual((await f.store.comments(f.path))[0].anchor, anchor);
});

test("only explicit Copilot completion after an edit resolves a sent comment", async (t) => {
    const f = await fixture(t);
    const comment = await f.store.submit(f.path, f.input);
    await assert.rejects(f.store.complete(f.path, comment.id), /document is unchanged/);
    await writeFile(f.path, f.source.replace("formatted", "clear"));
    assert.equal((await f.store.comments(f.path))[0].resolved, false);
    await f.store.complete(f.path, comment.id);
    const completed = (await f.store.comments(f.path))[0];
    assert.equal(completed.resolved, true);
    assert.equal(completed.resolvedBy, "copilot");
    assert.ok(completed.resolvedAt);
    await f.store.complete(f.path, comment.id);
    await f.store.resolve(f.path, { id: comment.id, resolved: false });
    assert.equal((await f.store.comments(f.path))[0].resolvedBy, undefined);
});

test("failed delivery cannot be completed as if Copilot handled it", async (t) => {
    const f = await fixture(t, async () => { throw new Error("Disconnected"); });
    await assert.rejects(f.store.submit(f.path, f.input));
    const [comment] = await f.store.comments(f.path);
    await writeFile(f.path, "Some unrelated change.");
    await assert.rejects(f.store.complete(f.path, comment.id), /delivery was not confirmed/);
    assert.equal((await f.store.comments(f.path))[0].resolved, false);
});

test("HTTP endpoints require a secret URL and same-origin JSON writes", async (t) => {
    const f = await fixture(t);
    const entry = await startServer({ path: f.path, store: f.store });
    t.after(entry.close);
    const origin = new URL(entry.url).origin;
    assert.equal((await fetch(origin)).status, 404);
    const state = await (await fetch(`${entry.url}state`)).json();
    assert.equal(state.path, f.path);
    assert.equal((await fetch(`${entry.url}comments`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify(f.input) })).status, 403);
    assert.equal((await fetch(`${entry.url}comments`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: "null" })).status, 400);
    const response = await fetch(`${entry.url}comments`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(f.input) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "sent");
});
