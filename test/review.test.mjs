import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewStore, renderDocument, validateConfig, editingBlocks } from "../review.mjs";
import { startServer } from "../server.mjs";
import { createConnection } from "node:net";
import { once } from "node:events";

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

test("partitions editable Markdown without dropping bytes or unsupported syntax", () => {
    for (const source of [
        "", "\n\n", "\uFEFF---\r\ntitle: Example\r\n---\r\n\r\n# Heading\r\n\r\nA paragraph.\r\n",
        "# Title\n\nA [reference][id].\n\n[id]: https://example.com\n\n<!-- keep -->\n",
        ":::custom\nunknown syntax\n:::\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n~~~mermaid\nflowchart LR\nA-->B\n~~~\n",
    ]) {
        const { blocks, tail } = editingBlocks(source);
        assert.equal(blocks.map((block) => block.prefix + block.source).join("") + tail, source);
        for (const block of blocks) assert.equal(source.slice(block.from, block.to), block.source);
    }
    assert.equal(editingBlocks("---\ntitle: Keep\n---\n").blocks[0].raw, true);
    assert.equal(editingBlocks("<!-- private -->\n").blocks[0].raw, true);
    assert.equal(editingBlocks("[ref]: https://example.com\n").blocks[0].raw, true);
    assert.equal(editingBlocks("```html\n<div>Safe code</div>\n```\n").blocks[0].raw, false);
    assert.equal(editingBlocks("```js title=example\nconst value = 1;\n```\n").blocks[0].raw, true);
    for (const source of ["[label][ref]\n", "[label][]\n", "[outer [inner][ref]\n", "[label] \n [ref]\n"]) {
        assert.equal(editingBlocks(source).blocks[0].raw, true, source);
    }
    for (const source of ["[label](url)\n", "[label][unfinished\n", "[".repeat(32000)]) {
        assert.equal(editingBlocks(source).blocks[0].raw, false, source);
    }
});

test("preserves shortcut reference blocks using document definitions", () => {
    for (const passage of ["See [guide].", "See [GuIdE].", "> See [guide].", "- See [guide].", "See [long\n label].", "See [escaped\\[label]."]) {
        const source = `${passage}\n\n[guide]: /docs\n[long label]: /long\n[escaped\\[label]: /escaped\n`;
        const { blocks, tail } = editingBlocks(source);
        assert.equal(blocks[0].raw, true, passage);
        assert.equal(blocks.map((block) => block.prefix + block.source).join("") + tail, source);
    }
    for (const passage of ["See [unknown].", "See [guide](/inline).", "See `[guide]`."]) {
        assert.equal(editingBlocks(`${passage}\n\n[guide]: /docs\n`).blocks[0].raw, false, passage);
    }
});

test("saves document revisions without changing comments and survives reopening", async (t) => {
    const f = await fixture(t);
    const comment = await f.store.submit(f.path, f.input);
    const source = `${f.source}\nSaved from Milkdown.\n`;
    const saved = await f.store.saveDocument(f.path, { source, revision: f.state.revision });
    assert.equal(saved.source, source);
    assert.notEqual(saved.revision, f.state.revision);
    assert.equal(await readFile(f.path, "utf8"), source);
    assert.equal((await f.store.comments(f.path))[0].id, comment.id);
    assert.equal((await f.store.comments(f.path))[0].resolved, false);
    assert.equal((await f.store.state(f.path)).source, source);
    assert.equal((await f.store.saveDocument(f.path, { source, revision: saved.revision })).revision, saved.revision);
});

test("rejects stale, oversized and invalid document writes without touching disk", async (t) => {
    const f = await fixture(t);
    for (const input of [{}, { source: null, revision: f.state.revision }, { source: "x", revision: 42 }, { source: "x".repeat(2 * 1024 * 1024 + 1), revision: f.state.revision }]) {
        await assert.rejects(f.store.saveDocument(f.path, input));
        assert.equal(await readFile(f.path, "utf8"), f.source);
    }
    await writeFile(f.path, "External change\n");
    await assert.rejects(f.store.saveDocument(f.path, { source: "Local draft\n", revision: f.state.revision }), /document changed on disk/);
    assert.equal(await readFile(f.path, "utf8"), "External change\n");
});

test("serializes saves and guards writes across independent providers", async (t) => {
    const f = await fixture(t);
    const results = await Promise.allSettled([
        f.store.saveDocument(f.path, { source: "First draft\n", revision: f.state.revision }),
        f.store.saveDocument(f.path, { source: "Second draft\n", revision: f.state.revision }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const winningSource = results.find((result) => result.status === "fulfilled").value.source;
    assert.equal(await readFile(f.path, "utf8"), winningSource);
    const lock = join(f.store.commentsPath(f.state.path), "document.lock");
    await mkdir(lock);
    const other = new ReviewStore({ storageRoot: join(f.root, "comments"), configPath: f.configPath, send: async () => "" });
    await assert.rejects(other.saveDocument(f.path, { source: "Other draft\n", revision: (await f.store.document(f.path)).revision }), /Another canvas is saving/);
    assert.equal(await readFile(f.path, "utf8"), winningSource);
});

test("does not report an externally replaced post-save document as the saved draft", async (t) => {
    const f = await fixture(t);
    const document = f.store.document.bind(f.store);
    let reads = 0;
    f.store.document = async (path) => {
        if (++reads === 4) await writeFile(path, "External replacement\n");
        return document(path);
    };
    await assert.rejects(f.store.saveDocument(f.path, { source: "Local draft\n", revision: f.state.revision }), /changed immediately after saving/);
    assert.equal(await readFile(f.path, "utf8"), "External replacement\n");
});

test("document HTTP writes are bound to the opened path and require same-origin JSON", async (t) => {
    const f = await fixture(t);
    const otherPath = join(f.root, "other.md");
    await writeFile(otherPath, "Keep other document");
    const entry = await startServer({ path: f.path, store: f.store });
    t.after(() => entry.close());
    const input = { source: "Saved through HTTP\n", revision: f.state.revision, path: otherPath };
    for (const origin of [undefined, "https://example.com"]) {
        const response = await fetch(`${entry.url}document`, {
            method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(input),
        });
        assert.equal(response.status, 403);
    }
    const response = await fetch(`${entry.url}document`, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: new URL(entry.url).origin }, body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).source, input.source);
    assert.equal(await readFile(otherPath, "utf8"), "Keep other document");
    assert.equal(await readFile(f.path, "utf8"), input.source);
    const large = "# Large document\n\n" + "x".repeat(160 * 1024);
    const largeResponse = await fetch(`${entry.url}document`, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: new URL(entry.url).origin },
        body: JSON.stringify({ source: large, revision: (await f.store.document(f.path)).revision }),
    });
    assert.equal(largeResponse.status, 200);
    assert.equal(await readFile(f.path, "utf8"), large);
});

test("closing a canvas releases speculative browser connections without waiting for request timeout", async (t) => {
    const f = await fixture(t);
    const entry = await startServer({ path: f.path, store: f.store });
    const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(entry.url).port) });
    t.after(() => socket.destroy());
    await once(socket, "connect");
    await entry.close();
    assert.equal(entry.server.listening, false);
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

test("shows a compact custom-feedback summary while preserving full model context", async (t) => {
    let sent;
    const f = await fixture(t, async (prompt, displayPrompt) => {
        sent = { prompt, displayPrompt };
        return "message";
    });
    const comment = await f.store.submit(f.path, f.input);
    assert.equal(sent.displayPrompt, "Markdown comment - doc.md:3\n\nMake this clearer.");
    assert.doesNotMatch(sent.displayPrompt, /sourceExcerpt|commentId|revision|formatted/);
    assert.ok(sent.prompt.includes(comment.id));
    assert.ok(sent.prompt.includes(f.state.revision));
    assert.ok(sent.prompt.includes(f.path.replaceAll("\\", "\\\\")));
    assert.match(sent.prompt, /A \*\*formatted\*\* passage/);
    assert.match(sent.prompt, /Make this clearer/);
    assert.match(sent.prompt, /markdown_comments_resolve_comment/);
});

test("shows the preset label in chat, not its expanded model instruction", async (t) => {
    let sent;
    const f = await fixture(t, async (prompt, displayPrompt) => {
        sent = { prompt, displayPrompt };
        return "message";
    });
    await f.store.submit(f.path, { ...f.input, promptId: "rewrite" });
    assert.equal(sent.displayPrompt, "Markdown comment - doc.md:3\n\nRewrite");
    assert.match(sent.prompt, /Rewrite clearly\./);
});

test("shows the inclusive source line range for a diagram comment", async (t) => {
    let summary;
    const f = await fixture(t, async (_prompt, displayPrompt) => { summary = displayPrompt; return "message"; });
    const source = "# Diagram\n\n```mermaid\nflowchart LR\nA-->B\n```\n";
    await writeFile(f.path, source);
    const state = await f.store.state(f.path);
    const quote = source.split("\n").slice(2, 6).join("\n");
    await f.store.submit(f.path, {
        ...f.input, revision: state.revision, kind: "diagram",
        quote, startLine: 2, endLine: 6, startOffset: 0, endOffset: quote.length,
    });
    assert.equal(summary, "Markdown comment - doc.md:3-6\n\nMake this clearer.");
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

test("serializes concurrent comment writes and persists explicit reopening as a new attempt", async (t) => {
    const f = await fixture(t);
    await Promise.all([f.store.submit(f.path, f.input), f.store.submit(f.path, f.input)]);
    const comments = await f.store.comments(f.path);
    assert.equal(comments.length, 2);
    await f.store.resolve(f.path, { id: comments[0].id, resolved: true });
    assert.equal((await f.store.comments(f.path))[0].resolved, true);
    const reopened = await f.store.reopen(f.path, { id: comments[0].id, selection: { ...f.input, kind: "text" } });
    assert.notEqual(reopened.id, comments[0].id);
    assert.equal(reopened.resolved, false);
    const original = (await f.store.comments(f.path)).find((comment) => comment.id === comments[0].id);
    assert.equal(original.resolved, true);
    assert.equal(original.reopenedAs, reopened.id);
    await assert.rejects(f.store.resolve(f.path, { id: original.id, resolved: false }), /Use Reopen/);
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
    const current = await f.store.state(f.path);
    const reopened = await f.store.reopen(f.path, {
        id: comment.id, retarget: true,
        selection: { ...f.input, revision: current.revision, quote: "clear", endOffset: 14 },
    });
    assert.equal(reopened.resolvedBy, undefined);
    const original = (await f.store.comments(f.path)).find((item) => item.id === comment.id);
    assert.equal(original.resolvedBy, "copilot");
    assert.equal(original.resolvedAt, completed.resolvedAt);
});

test("reopening dispatches updated context once and keeps original preset instructions after configuration changes", async (t) => {
    const sent = [];
    const f = await fixture(t, async (prompt, displayPrompt) => { sent.push({ prompt, displayPrompt }); return `message-${sent.length}`; });
    const original = await f.store.submit(f.path, { ...f.input, promptId: "rewrite" });
    await writeFile(f.path, `New heading\n\n${f.source}`);
    await f.store.complete(f.path, original.id);
    await writeFile(f.configPath, JSON.stringify({ prompts: [] }));
    const current = await f.store.state(f.path);
    assert.equal(current.comments[0].canReopen, true);
    const input = { id: original.id, selection: { ...f.input, kind: "text", revision: current.revision, startLine: 4, endLine: 5, startOffset: 22, endOffset: 31 } };
    const [reopened, duplicate] = await Promise.all([f.store.reopen(f.path, input), f.store.reopen(f.path, input)]);
    assert.equal(duplicate.id, reopened.id);
    assert.equal(sent.length, 2);
    assert.equal(reopened.previousCommentId, original.id);
    assert.equal(reopened.revision, current.revision);
    assert.equal(reopened.instruction, "Rewrite clearly.");
    assert.equal(reopened.messageId, "message-2");
    assert.equal(sent[1].displayPrompt, "Markdown comment - doc.md:5\n\nRewrite");
    assert.match(sent[1].prompt, /"first": 5/);
    assert.match(sent[1].prompt, /"documentStart": 22/);
    assert.match(sent[1].prompt, /A \*\*formatted\*\* passage/);
    assert.ok(sent[1].prompt.includes(current.revision));
    assert.ok(sent[1].prompt.includes(reopened.id));
    assert.match(sent[1].prompt, /markdown_comments_resolve_comment/);
    await assert.rejects(f.store.complete(f.path, original.id), /newer feedback attempt/);
    await assert.rejects(f.store.complete(f.path, reopened.id), /document is unchanged/);
    const restarted = new ReviewStore({ send: async () => assert.fail("duplicate dispatch"), storageRoot: join(f.root, "comments"), configPath: f.configPath });
    assert.equal((await restarted.reopen(f.path, input)).id, reopened.id);
});

test("changed, ambiguous, and legacy targets require explicit current selection without dispatch", async (t) => {
    let count = 0;
    const f = await fixture(t, async () => { count++; return "message"; });
    const original = await f.store.submit(f.path, f.input);
    await f.store.resolve(f.path, { id: original.id, resolved: true });
    for (const source of [f.source.replace("formatted", "clear"), `${f.source}\nA **formatted** passage.\n`]) {
        await writeFile(f.path, source);
        const current = await f.store.state(f.path);
        assert.equal(current.comments[0].canReopen, false);
        await assert.rejects(f.store.reopen(f.path, { id: original.id, selection: { ...f.input, kind: "text", revision: current.revision } }), /changed or is ambiguous/);
    }
    delete original.sourceExcerpt;
    original.resolved = true;
    await f.store.save(f.path, original);
    await writeFile(f.path, `${f.source}\nUnrelated addition.\n`);
    assert.equal((await f.store.state(f.path)).comments[0].canReopen, false);
    assert.equal(count, 1);
    const current = await f.store.state(f.path);
    const reopened = await f.store.reopen(f.path, {
        id: original.id, retarget: true, selection: { ...f.input, revision: current.revision, quote: "A repeated passage.", startLine: 4, endLine: 5 },
    });
    assert.equal(count, 2);
    assert.equal(reopened.quote, "A repeated passage.");
    assert.equal(reopened.instruction, original.instruction);
});

test("reopen rejects stale selections and already-pending work", async (t) => {
    const f = await fixture(t);
    const original = await f.store.submit(f.path, f.input);
    await assert.rejects(f.store.reopen(f.path, { id: original.id, retarget: true, selection: f.input }), /already awaiting/);
    await f.store.resolve(f.path, { id: original.id, resolved: true });
    await writeFile(f.path, `${f.source}\nExternal edit.\n`);
    await assert.rejects(f.store.reopen(f.path, { id: original.id, retarget: true, selection: f.input }), /document changed/);
    assert.equal((await f.store.comments(f.path)).length, 1);
});

test("retry failures persist independently, stay actionable, and cannot be resent through an old parent", async (t) => {
    let count = 0;
    const f = await fixture(t, async () => {
        if (++count === 2) throw new Error("Disconnected");
        return `message-${count}`;
    });
    const original = await f.store.submit(f.path, f.input);
    await f.store.resolve(f.path, { id: original.id, resolved: true });
    const input = { id: original.id, selection: { ...f.input, kind: "text" } };
    await assert.rejects(f.store.reopen(f.path, input), /Disconnected/);
    const comments = await f.store.comments(f.path);
    const failed = comments.find((comment) => comment.previousCommentId === original.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "Disconnected");
    assert.equal(comments.find((comment) => comment.id === original.id).resolved, true);
    await assert.rejects(f.store.reopen(f.path, input), /previous retry was not confirmed/);
    assert.equal(count, 2);
    const retry = await f.store.reopen(f.path, { ...input, id: failed.id });
    assert.equal(retry.status, "sent");
    assert.equal(retry.error, undefined);
    assert.equal(count, 3);
});

test("independent providers cannot dispatch the same reopen twice", async (t) => {
    let count = 0;
    const send = async () => { count++; await new Promise((resolve) => setTimeout(resolve, 30)); return "message"; };
    const f = await fixture(t, send);
    const other = new ReviewStore({ send, storageRoot: join(f.root, "comments"), configPath: f.configPath });
    const original = await f.store.submit(f.path, f.input);
    await f.store.resolve(f.path, { id: original.id, resolved: true });
    const input = { id: original.id, selection: { ...f.input, kind: "text" } };
    const results = await Promise.allSettled([f.store.reopen(f.path, input), other.reopen(f.path, input)]);
    assert.ok(results.some((result) => result.status === "fulfilled"));
    assert.equal(count, 2);
    assert.equal((await f.store.comments(f.path)).length, 2);
});

test("pending delivery and interrupted updates remain explicit and cannot duplicate sends", async (t) => {
    let count = 0;
    const f = await fixture(t, async () => { count++; return "message"; });
    const original = await f.store.submit(f.path, f.input);
    const input = { id: original.id, selection: { ...f.input, kind: "text" } };
    await f.store.save(f.path, { ...original, status: "pending", resolved: true });
    await assert.rejects(f.store.reopen(f.path, input), /Delivery is unconfirmed/);
    await f.store.save(f.path, { ...original, resolved: true });
    await mkdir(join(f.store.commentsPath(f.path), `${original.id}.lock`));
    await assert.rejects(f.store.reopen(f.path, input), /update is in progress or was interrupted/);
    assert.equal(count, 1);
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
    const original = await response.json();
    assert.equal(original.status, "sent");
    await f.store.resolve(f.path, { id: original.id, resolved: true });
    const reopen = await fetch(`${entry.url}reopen`, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ id: original.id, selection: { ...f.input, kind: "text" } }),
    });
    assert.equal(reopen.status, 200);
    assert.equal((await reopen.json()).previousCommentId, original.id);
    assert.equal((await fetch(`${entry.url}reopen`, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}",
    })).status, 403);
});
