import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewStore } from "../review.mjs";
import { startServer } from "../server.mjs";

let root, path, store, entry, sendError;
const sent = [];
const source = "# Editor prototype\n\nA **formatted** passage to improve.\n\nThe second paragraph needs context.\n\n```mermaid\nflowchart LR\n A[Select] --> B[Comment]\n```\n";

test.beforeEach(async ({ page }) => {
    sendError = undefined;
    root = await mkdtemp(join(tmpdir(), "markdown-editor-"));
    path = join(root, "draft.md");
    await writeFile(path, source);
    store = new ReviewStore({ storageRoot: join(root, "comments"), send: async (prompt) => {
        if (sendError) throw new Error(sendError);
        sent.push(prompt);
        return "message";
    } });
    entry = await startServer({ path, store });
    await page.goto(entry.url);
    await expect(page.locator("#document svg")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Editable Markdown", exact: true })).toBeEditable();
});
test.afterEach(async ({ page }) => {
    await page.close();
    await entry.close();
    await rm(root, { recursive: true, force: true });
});

async function append(page, text = " Added manually.") {
    const paragraph = page.locator(".ProseMirror > p").first();
    await paragraph.click();
    await page.keyboard.press("End");
    await page.keyboard.type(text);
}

async function saved(page) {
    await expect(page.locator("#edit-status")).toHaveText("Saved");
}

async function select(page, text) {
    await page.locator("#document").evaluate((article, text) => {
        const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            if (walker.currentNode.parentElement.closest(".editor-diagram")) continue;
            const index = walker.currentNode.textContent.indexOf(text);
            if (index < 0) continue;
            const range = document.createRange();
            range.setStart(walker.currentNode, index);
            range.setEnd(walker.currentNode, index + text.length);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
            return;
        }
        throw new Error(`Missing selection: ${text}`);
    }, text);
    await expect(page.locator("#new-comment")).toBeVisible();
    await page.locator("#new-comment").click();
}

test("opens editable by default, autosaves, undoes saved edits and reopens without manual controls", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.getByRole("button", { name: /^(Save|Refresh|Edit Markdown|Review mode)$/ })).toHaveCount(0);
    await expect(page.locator("#draft-source, #draft-markdown")).toHaveCount(0);
    await expect(page.locator("#notice")).toBeHidden();
    await expect(page.locator(".ProseMirror strong")).toHaveText("formatted");
    await append(page);
    await saved(page);
    expect(await readFile(path, "utf8")).toContain("Added manually.");
    await page.keyboard.press("Control+z");
    await expect(page.locator(".ProseMirror")).not.toContainText("Added manually.");
    await saved(page);
    expect(await readFile(path, "utf8")).toBe(source);
    await append(page);
    await saved(page);
    await page.reload();
    await expect(page.locator(".ProseMirror")).toContainText("Added manually.");
    expect(errors).toEqual([]);
});

test("debounces a burst of edits into one document write", async ({ page }) => {
    const writes = [];
    page.on("request", (request) => { if (request.url().endsWith("/document")) writes.push(request.postDataJSON()); });
    await append(page, " A burst of typing.");
    await saved(page);
    expect(writes).toHaveLength(1);
    expect(await readFile(path, "utf8")).toContain("A burst of typing.");
});

test("continuous typing schedules autosave within two seconds instead of waiting indefinitely for idle", async ({ page }) => {
    const text = " Continuous typing still saves.";
    await page.locator(".ProseMirror > p").first().click();
    await page.keyboard.press("End");
    const firstWrite = page.waitForRequest((request) => request.url().endsWith("/document"), { timeout: 2800 });
    const typing = page.keyboard.type(text, { delay: 120 });
    const request = await firstWrite;
    expect(request.postDataJSON().source).not.toContain(text);
    await typing;
    await saved(page);
    expect(await readFile(path, "utf8")).toBe(source.replace("passage to improve.", `passage to improve.${text}`));
});

test("typing during an in-flight autosave persists the newer draft in a serialized second save", async ({ page }) => {
    let started, release;
    const firstStarted = new Promise((resolve) => { started = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    let writes = 0;
    await page.route("**/document", async (route) => {
        if (++writes === 1) { started(); await gate; }
        await route.continue();
    });
    await append(page, " First.");
    await firstStarted;
    await expect(page.locator("#edit-status")).toHaveText("Saving...");
    await expect(page.getByRole("textbox", { name: "Editable Markdown", exact: true })).toBeEditable();
    await page.keyboard.type(" Second.");
    release();
    await saved(page);
    expect(await readFile(path, "utf8")).toBe(source.replace("passage to improve.", "passage to improve. First. Second."));
    expect(writes).toBe(2);
    await expect(page.locator(".ProseMirror")).toContainText("First. Second.");
});

test("posting feedback flushes pending autosave and sends the latest selection and revision", async ({ page }) => {
    const count = sent.length;
    await append(page);
    await select(page, "formatted");
    await page.getByLabel("Custom feedback", { exact: true }).fill("Clarify this term.");
    await page.getByRole("button", { name: "Post comment", exact: true }).click();
    await expect(page.locator("#composer")).toBeHidden();
    expect(sent.length).toBe(count + 1);
    expect(sent.at(-1)).toContain('"selectedQuote": "formatted"');
    expect(sent.at(-1)).toContain("Added manually.");
    const current = await store.state(path);
    expect(current.comments[0].revision).toBe(current.revision);
    expect(current.comments[0].sourceExcerpt).toContain("Added manually.");
    await expect(page.locator("#connectors path")).toHaveCount(1);
});

test("posting feedback waits for an already in-flight save before dispatching", async ({ page }) => {
    const count = sent.length;
    let started, release;
    const firstStarted = new Promise((resolve) => { started = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    let writes = 0;
    await page.route("**/document", async (route) => {
        if (++writes === 1) { started(); await gate; }
        await route.continue();
    });
    await append(page);
    await firstStarted;
    await select(page, "formatted");
    await page.getByRole("button", { name: "Rewrite", exact: true }).click();
    await expect(page.getByRole("button", { name: "Post comment", exact: true })).toBeDisabled();
    expect(sent.length).toBe(count);
    release();
    await expect(page.locator("#composer")).toBeHidden();
    expect(sent.length).toBe(count + 1);
    const current = await store.state(path);
    expect(current.comments[0].revision).toBe(current.revision);
    expect(current.comments[0].sourceExcerpt).toContain("Added manually.");
});

test("a stale poll response cannot replace a newer accepted autosave", async ({ page }) => {
    let started, release;
    const readStarted = new Promise((resolve) => { started = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    let first = true;
    await page.route("**/state", async (route) => {
        if (!first) return route.continue();
        first = false;
        const response = await route.fetch();
        started();
        await gate;
        await route.fulfill({ response });
    });
    await readStarted;
    await append(page);
    await saved(page);
    const response = page.waitForResponse((response) => response.url().endsWith("/state"));
    release();
    await response;
    await append(page, " Still current.");
    await saved(page);
    expect(await readFile(path, "utf8")).toBe(source.replace("passage to improve.", "passage to improve. Added manually. Still current."));
    await expect(page.getByRole("button", { name: "Use disk version", exact: true })).toBeHidden();
});

test("comments follow local edits, including within the quote, and unlink on deletion", async ({ page }) => {
    await select(page, "formatted");
    await page.getByRole("button", { name: "Rewrite", exact: true }).click();
    await expect(page.locator("#composer")).toBeHidden();
    await append(page);
    await saved(page);
    await page.locator(".ProseMirror strong").evaluate((element) => {
        const range = document.createRange();
        range.setStart(element.firstChild, 2);
        range.setEnd(element.firstChild, 5);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
    });
    await page.keyboard.type("X");
    await expect(page.locator(".ProseMirror strong")).toHaveText("foXtted");
    await expect(page.locator("#comments .comment")).not.toHaveClass(/outdated/);
    expect(await page.evaluate(() => [...CSS.highlights.get("review-comments")][0].toString())).toBe("foXtted");
    await page.locator(".ProseMirror strong").click();
    await page.keyboard.press("Home");
    await expect.poll(() => page.locator(".ProseMirror > p").first().evaluate((element) => {
        const selection = window.getSelection();
        return selection.anchorNode === element.firstChild && selection.anchorOffset === 0;
    })).toBe(true);
    await page.keyboard.press("Shift+End");
    await page.keyboard.type("Replacement paragraph.");
    await expect(page.locator("#comments .comment")).toHaveClass(/outdated/);
    await expect(page.locator("#connectors path")).toHaveCount(0);
    await saved(page);
    expect((await store.comments(path))[0].resolved).toBe(false);
});

test("automatically applies external edits in the same editor without echo writes or losing the caret", async ({ page }) => {
    const writes = [];
    page.on("request", (request) => { if (request.url().endsWith("/document")) writes.push(request); });
    await page.locator(".ProseMirror strong").click();
    await page.keyboard.press("Home");
    await expect.poll(() => page.locator(".ProseMirror > p").first().evaluate((element) => {
        const selection = window.getSelection();
        return selection.anchorNode === element.firstChild && selection.anchorOffset === 0;
    })).toBe(true);
    const oldEditor = await page.locator(".ProseMirror").elementHandle();
    await writeFile(path, `${source}\nExternal Copilot edit.\n`);
    await expect(page.locator(".ProseMirror")).toContainText("External Copilot edit.", { timeout: 10000 });
    expect(await oldEditor.evaluate((element) => element === document.querySelector(".ProseMirror"))).toBe(true);
    expect(await page.evaluate(() => document.activeElement === document.querySelector(".ProseMirror"))).toBe(true);
    expect(writes).toHaveLength(0);
    expect(await page.locator(".ProseMirror > p").first().evaluate((element) => {
        const selection = window.getSelection();
        return selection.anchorNode === element.firstChild && selection.anchorOffset === 0;
    })).toBe(true);
    await page.keyboard.type("Caret ");
    await saved(page);
    expect(await readFile(path, "utf8")).toContain("Caret A **formatted**");
});

test("preserves a selected passage across a clean external insertion and comments on its current revision", async ({ page }) => {
    const count = sent.length;
    await page.locator(".ProseMirror strong").click();
    await page.locator(".ProseMirror strong").evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
    });
    await expect(page.locator("#new-comment")).toBeVisible();
    await writeFile(path, source.replace("A **formatted**", "A new external paragraph.\n\nA **formatted**"));
    await expect(page.locator(".ProseMirror")).toContainText("A new external paragraph.", { timeout: 10000 });
    expect(await page.evaluate(() => window.getSelection().toString())).toBe("formatted");
    await page.locator("#new-comment").click();
    await page.getByRole("button", { name: "Rewrite", exact: true }).click();
    await expect(page.locator("#composer")).toBeHidden();
    expect(sent.length).toBe(count + 1);
    const current = await store.state(path);
    expect(current.comments[0].revision).toBe(current.revision);
    expect(current.comments[0].startLine).toBe(4);
});

test("external updates reset undo history instead of undoing another editor's revision", async ({ page }) => {
    await append(page);
    await saved(page);
    const external = `${await readFile(path, "utf8")}\nNew external revision.\n`;
    await writeFile(path, external);
    await expect(page.locator(".ProseMirror")).toContainText("New external revision.", { timeout: 10000 });
    await page.keyboard.press("Control+z");
    await expect(page.locator(".ProseMirror")).toContainText("Added manually.");
    await expect(page.locator(".ProseMirror")).toContainText("New external revision.");
    expect(await readFile(path, "utf8")).toBe(external);
});

test("stale autosaves preserve local edits, reject feedback, and expose explicit conflict recovery", async ({ page }) => {
    const count = sent.length;
    await append(page);
    const external = `${source}\nExternal change.\n`;
    await writeFile(path, external);
    await expect(page.locator("#edit-status")).toHaveText("Disk changed - local draft preserved", { timeout: 10000 });
    await expect(page.locator(".ProseMirror")).toContainText("Added manually.");
    await select(page, "formatted");
    await page.getByRole("button", { name: "Rewrite", exact: true }).click();
    await expect(page.locator("#notice")).toContainText("document changed on disk");
    await expect(page.locator("#composer")).toBeVisible();
    expect(sent.length).toBe(count);
    expect(await readFile(path, "utf8")).toBe(external);
    await expect(page.locator(".ProseMirror > p").first()).toHaveText("A formatted passage to improve. Added manually.");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Use disk version", exact: true }).click();
    await expect(page.locator("#composer")).toBeHidden();
    await expect(page.locator(".ProseMirror")).toContainText("External change.");
    await expect(page.locator(".ProseMirror")).not.toContainText("Added manually.");
    await append(page, " New draft.");
    await saved(page);
    expect(await readFile(path, "utf8")).toContain("New draft.");
});

test("failed autosave remains visibly unsaved and retries only when requested", async ({ page }) => {
    let writes = 0;
    await page.route("**/document", (route) => { writes++; return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Disk write failed" }) }); });
    await append(page);
    await expect(page.locator("#edit-status")).toHaveText("Not saved - retry needed");
    await expect(page.locator("#notice")).toContainText("Disk write failed");
    await expect(page.locator("#notice")).toBeVisible();
    await page.waitForResponse((response) => response.url().endsWith("/state"));
    expect(writes).toBe(1);
    expect(await readFile(path, "utf8")).toBe(source);
    await page.unroute("**/document");
    await page.getByRole("button", { name: "Retry autosave", exact: true }).click();
    await saved(page);
    await expect(page.locator("#notice")).not.toContainText("Disk write failed");
    expect(await readFile(path, "utf8")).toContain("Added manually.");
});

test("an external update waits while composing a comment then reloads automatically on cancel", async ({ page }) => {
    await select(page, "formatted");
    await page.getByLabel("Custom feedback", { exact: true }).fill("Keep my draft.");
    await writeFile(path, `${source}\nChanged while commenting.\n`);
    await expect(page.locator("#edit-status")).toHaveText("Disk changed - local draft preserved", { timeout: 10000 });
    await expect(page.getByLabel("Custom feedback", { exact: true })).toHaveValue("Keep my draft.");
    await expect(page.locator(".ProseMirror")).not.toContainText("Changed while commenting.");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator(".ProseMirror")).toContainText("Changed while commenting.", { timeout: 10000 });
});

test("autosaves structural edits and editable tables without rewriting surrounding Markdown", async ({ page }) => {
    await writeFile(path, `${source}\n| A | B |\n| - | - |\n| 1 | 2 |\n`);
    await expect(page.locator(".ProseMirror table")).toHaveCount(1, { timeout: 10000 });
    await page.locator(".ProseMirror td").first().click();
    await page.keyboard.type("Changed ");
    await saved(page);
    expect((await readFile(path, "utf8")).startsWith(source)).toBe(true);
    const paragraph = page.locator(".ProseMirror > p").first();
    await paragraph.click();
    await page.keyboard.press("Home");
    await expect.poll(() => paragraph.evaluate((element) => {
        const selection = window.getSelection();
        return selection.isCollapsed && selection.anchorNode === element.firstChild && selection.anchorOffset === 0;
    })).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.locator(".ProseMirror > p").first()).toHaveText("");
    await page.locator(".ProseMirror > p").first().click();
    await page.keyboard.type("Inserted paragraph.");
    await saved(page);
    expect(await readFile(path, "utf8")).toContain("Inserted paragraph.\n\nA **formatted** passage");
});

test("preserves CRLF, front matter, reference syntax, HTML and custom syntax through autosave", async ({ page }) => {
    const special = "---\r\ntitle: Keep\r\n---\r\n\r\n# Editor prototype\r\n\r\nA **formatted** passage to improve.\r\n\r\n*  original list marker\r\n\r\n[reference]: https://example.com \"Original title\"\r\n\r\n[Keep this][reference]\r\n\r\n<!-- exact HTML -->\r\n\r\n:::custom\r\nuntouched syntax\r\n:::\r\n";
    await writeFile(path, special);
    await expect(page.locator(".raw-source")).toContainText(["title: Keep", "[reference]:", "[Keep this][reference]", "<!-- exact HTML -->", ":::custom"], { timeout: 10000 });
    await append(page);
    await saved(page);
    expect(await readFile(path, "utf8")).toBe(special.replace("passage to improve.", "passage to improve. Added manually."));
    await append(page, " Again.");
    await saved(page);
    expect(await readFile(path, "utf8")).toBe(special.replace("passage to improve.", "passage to improve. Added manually. Again."));
});

test("Mermaid source autosaves, updates its preview and remains commentable", async ({ page }) => {
    await page.locator('.ProseMirror pre[data-language="mermaid"]').click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.keyboard.type(" A[Select] --> B[Feedback]");
    await expect(page.locator(".editor-diagram svg")).toContainText("Feedback");
    await saved(page);
    await page.getByRole("button", { name: "Comment on diagram", exact: true }).click();
    await page.getByRole("button", { name: "Rewrite", exact: true }).click();
    await expect(page.locator("#composer")).toBeHidden();
    expect((await store.comments(path))[0].kind).toBe("diagram");
    expect(sent.at(-1)).toContain("B[Feedback]");
});

test("HTML and images stay literal without remote resource requests", async ({ page }) => {
    const external = [];
    page.on("request", (request) => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== "127.0.0.1") external.push(request.url()); });
    await writeFile(path, `${source}\n![private](https://example.com/private.png)\n\n<script>window.pwned = true</script>\n`);
    await expect(page.locator(".raw-source")).toContainText(["![private]", "<script>"], { timeout: 10000 });
    await expect(page.locator(".ProseMirror img, .ProseMirror script")).toHaveCount(0);
    await page.locator(".raw-source").last().click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("A source edit.");
    await saved(page);
    expect(await readFile(path, "utf8")).toContain("A source edit.");
    expect(await page.evaluate(() => window.pwned)).toBeUndefined();
    expect(external).toEqual([]);
});

test("delivery failure after autosave does not lose the document or comment draft", async ({ page }) => {
    await append(page);
    await select(page, "formatted");
    sendError = "Sender disconnected";
    await page.getByRole("button", { name: "Rewrite", exact: true }).click();
    await expect(page.locator("#notice")).toContainText("Sender disconnected");
    await saved(page);
    expect(await readFile(path, "utf8")).toContain("Added manually.");
    expect((await store.comments(path))[0].status).toBe("failed");
    await expect(page.locator("#composer")).toBeVisible();
});

test("duplicate paragraphs retain their individual whitespace after an external update", async ({ page }) => {
    const duplicate = `${source}\nRepeated paragraph.\n\n\n\nRepeated paragraph.\n`;
    await writeFile(path, duplicate);
    await expect(page.locator(".ProseMirror > p")).toHaveCount(4, { timeout: 10000 });
    await writeFile(path, `${duplicate}\nExternal addition.\n`);
    await expect(page.locator(".ProseMirror")).toContainText("External addition.", { timeout: 10000 });
    await append(page);
    await saved(page);
    expect(await readFile(path, "utf8")).toBe(`${duplicate}\nExternal addition.\n`.replace("passage to improve.", "passage to improve. Added manually."));
});

test("unchanged diagrams retain their rendered widget while earlier text shifts their positions", async ({ page }) => {
    const widget = await page.locator(".editor-diagram").elementHandle();
    const svg = await page.locator(".editor-diagram svg").elementHandle();
    const position = await widget.getAttribute("data-position");
    await append(page, " Typing before the diagram.");
    await saved(page);
    expect(await widget.evaluate((element) => element === document.querySelector(".editor-diagram"))).toBe(true);
    expect(await svg.evaluate((element) => element === document.querySelector(".editor-diagram svg"))).toBe(true);
    expect(await widget.getAttribute("data-position")).not.toBe(position);
    await page.getByRole("button", { name: "Comment on diagram", exact: true }).click();
    await page.getByRole("button", { name: "Rewrite", exact: true }).click();
    await expect(page.locator("#composer")).toBeHidden();
    expect((await store.comments(path))[0].quote).toBe("```mermaid\nflowchart LR\n A[Select] --> B[Comment]\n```");
    await expect(page.locator("#connectors path")).toHaveCount(1);
});

for (const container of ["blockquote", "list"]) {
    test(`nested ${container} diagrams retain full source ranges and anchors`, async ({ page }) => {
        const fence = container === "blockquote" ? "> ```mermaid\n> flowchart LR\n> A-->B\n> ```" :
            "- ```mermaid\n  flowchart LR\n  A-->B\n  ```";
        await writeFile(path, `# Nested\n\n${fence}\n`);
        await expect(page.locator(".ProseMirror h1")).toHaveText("Nested", { timeout: 10000 });
        await expect(page.locator(".ProseMirror pre[data-language=mermaid]")).toHaveCount(1, { timeout: 10000 });
        await expect(page.locator(".editor-diagram svg")).toBeVisible();
        await page.getByRole("button", { name: "Comment on diagram", exact: true }).click();
        await page.getByRole("button", { name: "Rewrite", exact: true }).click();
        await expect(page.locator("#composer")).toBeHidden();
        const comment = (await store.comments(path))[0];
        expect(comment).toMatchObject({ kind: "diagram", quote: fence, sourceExcerpt: fence, startLine: 2, endLine: 6 });
        await page.reload();
        await expect(page.locator("#comments .comment")).toBeVisible();
        await expect(page.locator("#comments .comment")).not.toHaveClass(/outdated/);
        await expect(page.locator("#connectors path")).toHaveCount(1);
        await writeFile(path, `# Intro\n\n# Nested\n\n${fence}\n`);
        await expect(page.locator(".ProseMirror h1")).toHaveCount(2, { timeout: 10000 });
        await expect(page.locator("#comments .comment")).not.toHaveClass(/outdated/);
        await expect(page.locator("#connectors path")).toHaveCount(1);
    });
}

test("diagram feedback retries retain their kind and full fence after delivery failure", async ({ page }) => {
    const quote = "```mermaid\nflowchart LR\n A[Select] --> B[Comment]\n```";
    await page.getByRole("button", { name: "Comment on diagram", exact: true }).click();
    await page.getByLabel("Custom feedback", { exact: true }).fill("Simplify the diagram.");
    sendError = "Sender disconnected";
    await page.getByRole("button", { name: "Post comment", exact: true }).click();
    await expect(page.locator("#notice")).toContainText("Sender disconnected");
    await expect(page.locator("#composer")).toBeVisible();
    sendError = undefined;
    await page.getByRole("button", { name: "Post comment", exact: true }).click();
    await expect(page.locator("#composer")).toBeHidden();
    const comments = await store.comments(path);
    expect(comments).toHaveLength(2);
    for (const comment of comments) expect(comment).toMatchObject({ kind: "diagram", quote, sourceExcerpt: quote });
});

test("previously saved CRLF diagram quotes keep their anchors", async ({ page }) => {
    const crlf = source.replace(/\n/g, "\r\n");
    await writeFile(path, crlf);
    const current = await store.state(path);
    const quote = crlf.split("\n").slice(6, 10).join("\n");
    await store.submit(path, {
        revision: current.revision, kind: "diagram", quote, startLine: 6, endLine: 10,
        startOffset: 0, endOffset: quote.length, prompt: "Keep this diagram linked.",
    });
    await page.reload();
    await expect(page.locator("#comments .comment")).toBeVisible();
    await expect(page.locator("#comments .comment")).not.toHaveClass(/outdated/);
    await expect(page.locator("#connectors path")).toHaveCount(1);
    await append(page);
    await saved(page);
    expect(await readFile(path, "utf8")).toBe(crlf.replace("passage to improve.", "passage to improve. Added manually."));
    await page.reload();
    await expect(page.locator("#comments .comment")).not.toHaveClass(/outdated/);
    await expect(page.locator("#connectors path")).toHaveCount(1);
});

test("retarget save failures preserve the composer until autosave is explicitly retried", async ({ page }) => {
    await select(page, "formatted");
    await page.getByRole("button", { name: "Rewrite", exact: true }).click();
    await expect(page.locator("#composer")).toBeHidden();
    const original = (await store.comments(path))[0];
    await writeFile(path, source.replace("formatted", "clearer"));
    await expect(page.locator(".ProseMirror strong")).toHaveText("clearer", { timeout: 10000 });
    await page.getByRole("button", { name: "Select current passage", exact: true }).click();
    await page.route("**/document", (route) => route.fulfill({
        status: 500, contentType: "application/json", body: JSON.stringify({ error: "Disk write failed" }),
    }));
    await append(page);
    await select(page, "clearer");
    await page.getByRole("button", { name: "Resubmit feedback", exact: true }).click();
    await expect(page.locator("#notice")).toContainText("Disk write failed");
    await expect(page.locator("#composer")).toBeVisible();
    await expect(page.getByLabel("Custom feedback", { exact: true })).toHaveValue(original.instruction);
    await expect(page.locator("#selection")).toHaveText("clearer");
    expect(await store.comments(path)).toHaveLength(1);
    await page.unroute("**/document");
    await page.getByRole("button", { name: "Retry autosave", exact: true }).click();
    await saved(page);
    await expect(page.locator("#composer")).toBeVisible();
    await page.getByRole("button", { name: "Resubmit feedback", exact: true }).click();
    await expect(page.locator("#composer")).toBeHidden();
    expect(await store.comments(path)).toHaveLength(2);
});

test("empty documents autosave without accumulating whitespace", async ({ page }) => {
    await writeFile(path, "\n");
    await expect(page.locator(".ProseMirror")).toHaveText("", { timeout: 10000 });
    const textbox = page.getByRole("textbox", { name: "Editable Markdown", exact: true });
    await textbox.fill("First.");
    await saved(page);
    const first = await readFile(path, "utf8");
    await textbox.fill("");
    await saved(page);
    await textbox.fill("Second.");
    await saved(page);
    expect(await readFile(path, "utf8")).toBe(first.replace("First.", "Second."));
});
