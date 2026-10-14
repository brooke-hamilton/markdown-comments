import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewStore } from "../review.mjs";
import { startServer } from "../server.mjs";

let root, path, entry, store, documentNumber = 0;
const sent = [];
const source = "# Test document\n\nA **formatted** passage to improve.\n\nThe second paragraph needs context.\n\n```mermaid\nflowchart LR\n A[Select] --> B[Comment]\n```\n\n<script>window.pwned = true</script>\n";

test.beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "markdown-comments-browser-"));
    store = new ReviewStore({ send: async (prompt) => { sent.push(prompt); return `message-${sent.length}`; }, storageRoot: join(root, "comments") });
});
test.afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
    path = join(root, `document-${documentNumber++}.md`);
    await writeFile(path, source);
    entry = await startServer({ path, store });
    await page.goto(entry.url);
    await expect(page.locator("#document svg")).toBeVisible();
});
test.afterEach(async () => {
    await entry.close();
});

async function select(page, text = "formatted", open = true) {
    await page.locator("#document").evaluate((article, text) => {
        const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const index = walker.currentNode.textContent.indexOf(text);
            if (index < 0) continue;
            const range = document.createRange();
            range.setStart(walker.currentNode, index);
            range.setEnd(walker.currentNode, index + text.length);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
            return;
        }
        throw new Error(`Text not found: ${text}`);
    }, text);
    await expect(page.locator("#new-comment")).toBeVisible();
    if (open) await page.locator("#new-comment").click();
    await expect(page.locator("#selection")).toHaveText(text);
}

async function post(page, feedback = "Use a simpler term.") {
    await select(page);
    await page.getByLabel("Custom feedback", { exact: true }).fill(feedback);
    await page.getByRole("button", { name: "Post comment", exact: true }).click();
    await expect(page.locator("#comments")).toContainText(feedback);
    await expect(page.locator("#composer")).toBeHidden();
    return (await store.comments(path)).at(-1);
}

test("renders formatted Markdown and Mermaid without a detached always-visible form", async ({ page }) => {
    await expect(page.locator("#document strong")).toHaveText("formatted");
    await expect(page.locator("#document svg")).toContainText("Select");
    expect(await page.evaluate(() => window.pwned)).toBeUndefined();
    await expect(page.locator("#composer")).toBeHidden();
    await expect(page.locator("#selection-toolbar")).toBeHidden();
});

test("shows New comment beside the selection and opens an anchored, focused margin composer", async ({ page }) => {
    await select(page, "formatted", false);
    const text = await page.locator("#document strong").boundingBox();
    const toolbar = await page.locator("#selection-toolbar").boundingBox();
    expect(Math.abs(toolbar.y - (text.y + text.height))).toBeLessThan(20);
    await page.locator("#new-comment").click();
    await expect(page.getByLabel("Custom feedback", { exact: true })).toBeFocused();
    const composer = await page.locator("#composer").boundingBox();
    expect(Math.abs(composer.y - text.y)).toBeLessThan(25);
    expect(composer.x).toBeGreaterThan(text.x + text.width);
    await expect(page.locator('#connectors path[data-comment-id="draft"]')).toHaveCount(1);
    expect(await page.evaluate(() => CSS.highlights.get("review-draft").size)).toBe(1);
});

test("posts selected text with source location while keeping the anchored comment visible", async ({ page }) => {
    const count = sent.length;
    const comment = await post(page);
    expect(sent.length).toBe(count + 1);
    expect(sent.at(-1)).toContain('"selectedQuote": "formatted"');
    expect(sent.at(-1)).toContain('"first": 3');
    expect(sent.at(-1)).toContain("A **formatted** passage");
    expect(sent.at(-1)).toContain("markdown_comments_resolve_comment");
    expect(comment.resolved).toBe(false);
    await expect(page.locator(".comment.active")).toHaveCount(1);
    await expect(page.locator("#comments")).toContainText("Waiting for Copilot to resolve");
    await expect(page.getByRole("button", { name: "Resolve", exact: true })).toHaveCount(0);
    const text = await page.locator("#document strong").boundingBox();
    const balloon = await page.locator("#comments .comment").boundingBox();
    expect(Math.abs(balloon.y - text.y)).toBeLessThan(25);
    expect(await page.evaluate(() => CSS.highlights.get("review-comments").size)).toBe(1);
});

test("preset comment disappears only after Copilot explicitly completes it", async ({ page }) => {
    await select(page, "second paragraph");
    await page.getByRole("button", { name: "Provide more context", exact: true }).click();
    await expect(page.locator("#comments")).toContainText("Provide more context");
    expect(sent.at(-1)).toContain("Do not invent facts");
    const comment = (await store.comments(path))[0];
    await assertUnchangedCannotResolve(comment);
    await writeFile(path, source.replace("The second paragraph needs context.", "The second paragraph explains the background."));
    await expect(page.locator("#document")).toContainText("explains the background", { timeout: 10000 });
    await expect(page.locator("#comments .comment")).toHaveCount(1);
    await store.complete(path, comment.id);
    await expect(page.locator("#comments .comment")).toHaveCount(0, { timeout: 10000 });
    await page.getByRole("button", { name: /Show resolved/ }).click();
    await expect(page.locator(".comment.resolved")).toHaveCount(1);
    await page.getByRole("button", { name: "Reopen", exact: true }).click();
    await expect(page.locator("#comments")).toContainText("Waiting for Copilot to resolve");
});

async function assertUnchangedCannotResolve(comment) {
    let error;
    try { await store.complete(path, comment.id); } catch (value) { error = value; }
    expect(error?.message).toContain("document is unchanged");
}

test("diagram composer and saved comment are anchored beside the Mermaid diagram", async ({ page }) => {
    await page.getByRole("button", { name: "Comment on diagram" }).click();
    await expect(page.locator("#selection")).toContainText("```mermaid");
    await expect(page.getByLabel("Custom feedback", { exact: true })).toBeFocused();
    const figure = await page.locator("#document figure").boundingBox();
    const composer = await page.locator("#composer").boundingBox();
    expect(Math.abs(composer.y - figure.y)).toBeLessThan(5);
    await page.getByRole("button", { name: "Rewrite", exact: true }).click();
    await expect(page.locator("#comments")).toContainText("flowchart LR");
    expect(sent.at(-1)).toContain("A[Select] --> B[Comment]");
    const balloon = await page.locator("#comments .comment").boundingBox();
    const currentFigure = await page.locator("#document figure").boundingBox();
    expect(Math.abs(balloon.y - currentFigure.y)).toBeLessThan(5);
});

test("rejects stale selections and refreshes external edits", async ({ page }) => {
    const count = sent.length;
    await select(page);
    await writeFile(path, `${source}\nNew content from an external edit.\n`);
    await page.getByRole("button", { name: "Fix this slop", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("document changed");
    expect(sent.length).toBe(count);
    await expect(page.locator("#composer")).toBeVisible();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator("#composer")).toBeHidden();
    await expect(page.locator("#document")).toContainText("New content from an external edit.");
});

test("comments survive reopening the same document in a fresh server instance", async ({ page }) => {
    await post(page);
    const reopened = await startServer({ path, store });
    try {
        await page.goto(reopened.url);
        await expect(page.locator("#comments")).toContainText("Use a simpler term.");
        await expect(page.locator("#connectors path")).toHaveCount(1);
    } finally {
        await reopened.close();
    }
});

test("captures a selection spanning formatting and multiple paragraphs", async ({ page }) => {
    await page.locator("#document").evaluate((article) => {
        const range = document.createRange();
        range.setStart(article.querySelector("strong").firstChild, 0);
        range.setEnd(article.querySelectorAll("p")[1].firstChild, 10);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
    });
    await page.locator("#new-comment").click();
    await expect(page.locator("#selection")).toContainText("The second");
    await page.getByRole("button", { name: "Rewrite", exact: true }).click();
    await expect(page.locator("#comments .comment")).toContainText("The second");
    expect(sent.at(-1)).toContain('"first": 3');
    expect(sent.at(-1)).toContain('"last": 5');
    expect(sent.at(-1)).toContain('"prefix": "A "');
});

test("invalid Mermaid remains commentable beside its source", async ({ page }) => {
    await writeFile(path, "# Broken diagram\n\n```mermaid\nnot a valid diagram\n```\n");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator("#document .error")).toContainText("Mermaid could not render");
    await page.getByRole("button", { name: "Comment on diagram" }).click();
    await expect(page.locator("#selection")).toContainText("not a valid diagram");
    const figure = await page.locator("#document figure").boundingBox();
    const composer = await page.locator("#composer").boundingBox();
    expect(Math.abs(composer.y - figure.y)).toBeLessThan(5);
});

test("keyboard shortcut opens a comment and Escape cancels without sending", async ({ page }) => {
    const count = sent.length;
    await select(page, "formatted", false);
    await page.keyboard.press("Control+Alt+m");
    await expect(page.getByLabel("Custom feedback", { exact: true })).toBeFocused();
    await page.getByLabel("Custom feedback", { exact: true }).fill("A draft only.");
    await page.keyboard.press("Escape");
    await expect(page.locator("#composer")).toBeHidden();
    await expect(page.locator("#selection-toolbar")).toBeHidden();
    expect(sent.length).toBe(count);
});

test("balloons avoid collisions and remain linked after resizing", async ({ page }) => {
    await post(page);
    await select(page, "second paragraph");
    await page.getByRole("button", { name: "Provide more context", exact: true }).click();
    await expect(page.locator("#comments .comment")).toHaveCount(2);
    for (const width of [1280, 700, 480]) {
        await page.setViewportSize({ width, height: 900 });
        await expect.poll(async () => {
            const boxes = await Promise.all([page.locator("#comments .comment").nth(0).boundingBox(), page.locator("#comments .comment").nth(1).boundingBox()]);
            boxes.sort((a, b) => a.y - b.y);
            return boxes[1].y - (boxes[0].y + boxes[0].height);
        }).toBeGreaterThanOrEqual(10);
        await expect(page.locator("#connectors path")).toHaveCount(2);
    }
});

test("a diagram draft stays beside the diagram even when an earlier balloon fills the margin", async ({ page }) => {
    await post(page, "This is an intentionally long comment. ".repeat(20));
    await page.getByRole("button", { name: "Comment on diagram" }).click();
    const figure = await page.locator("#document figure").boundingBox();
    const draft = await page.locator("#composer").boundingBox();
    expect(Math.abs(draft.y - figure.y)).toBeLessThan(5);
    const earlier = await page.locator("#comments .comment").boundingBox();
    expect(earlier.y >= draft.y + draft.height + 10 || earlier.y + earlier.height <= draft.y - 10).toBe(true);
});

test("clicking commented text activates its balloon and linked highlight", async ({ page }) => {
    const comment = await post(page);
    await page.locator("#document strong").click();
    await expect(page.locator(`#comment-${comment.id}`)).toBeFocused();
    await expect(page.locator(`#comment-${comment.id}`)).toHaveClass(/active/);
    expect(await page.evaluate(() => CSS.highlights.get("review-active").size)).toBe(1);
});

test("unchanged passages reattach after edits, but edited passages stay visible until resolved", async ({ page }) => {
    await post(page);
    await writeFile(path, `${source}\nAn unrelated addition.\n`);
    await expect(page.locator("#document")).toContainText("An unrelated addition.", { timeout: 10000 });
    await expect(page.locator("#comments")).toContainText("Passage unchanged");
    await expect(page.locator("#connectors path")).toHaveCount(1);
    const before = await page.locator("#comments .comment").boundingBox();
    await writeFile(path, source.replace("formatted", "clearer"));
    await expect(page.locator("#document strong")).toHaveText("clearer", { timeout: 10000 });
    await expect(page.locator("#comments .comment")).toHaveClass(/outdated/);
    await expect(page.locator("#comments")).toContainText("Waiting for Copilot to resolve");
    const after = await page.locator("#comments .comment").boundingBox();
    expect(Math.abs(before.y - after.y)).toBeLessThan(5);
    await expect(page.locator("#connectors path")).toHaveCount(0);
});

test("ambiguous repeated passages are not silently reattached", async ({ page }) => {
    await post(page);
    await writeFile(path, `${source}\nA **formatted** passage to improve.\n`);
    await expect(page.locator("#document strong")).toHaveCount(2, { timeout: 10000 });
    await expect(page.locator("#comments .comment")).toHaveClass(/outdated/);
    expect(await page.evaluate(() => CSS.highlights.get("review-comments").size)).toBe(0);
});
