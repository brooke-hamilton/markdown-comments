import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewStore } from "../review.mjs";
import { startServer } from "../server.mjs";

let root, path, entry, store;
const sent = [];
const source = "# Test document\n\nA **formatted** passage to improve.\n\nThe second paragraph needs context.\n\n```mermaid\nflowchart LR\n A[Select] --> B[Comment]\n```\n\n<script>window.pwned = true</script>\n";

test.beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "markdown-comments-browser-"));
    path = join(root, "document.md");
    store = new ReviewStore({ send: async (prompt) => { sent.push(prompt); return `message-${sent.length}`; }, storageRoot: join(root, "comments") });
    entry = await startServer({ path, store });
});
test.afterAll(async () => {
    await entry?.close();
    if (root) await rm(root, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
    await writeFile(path, source);
    await page.goto(entry.url);
    await expect(page.locator("#document svg")).toBeVisible();
});

async function select(page, text = "formatted") {
    await page.locator("#document").evaluate((article, text) => {
        const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const index = walker.currentNode.textContent.indexOf(text);
            if (index < 0) continue;
            const range = document.createRange();
            range.setStart(walker.currentNode, index);
            range.setEnd(walker.currentNode, index + text.length);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            return;
        }
        throw new Error(`Text not found: ${text}`);
    }, text);
    await expect(page.locator("#selection")).toHaveText(text);
}

test("renders formatted Markdown and Mermaid labels without executing HTML", async ({ page }) => {
    await expect(page.locator("#document strong")).toHaveText("formatted");
    await expect(page.locator("#document svg")).toContainText("Select");
    expect(await page.evaluate(() => window.pwned)).toBeUndefined();
    await expect(page.getByRole("button", { name: "Send to Copilot" })).toBeDisabled();
});

test("submits selected formatted text with source location and custom feedback", async ({ page }) => {
    const count = sent.length;
    await select(page);
    await page.getByLabel("Custom feedback", { exact: true }).fill("Use a simpler term.");
    await page.getByRole("button", { name: "Send to Copilot" }).click();
    await expect(page.locator("#comments")).toContainText("Use a simpler term.");
    expect(sent.length).toBe(count + 1);
    expect(sent.at(-1)).toContain('"selectedQuote": "formatted"');
    expect(sent.at(-1)).toContain('"first": 3');
    expect(sent.at(-1)).toContain("A **formatted** passage");
    expect(await page.evaluate(() => CSS.highlights.get("review-comments").size)).toBeGreaterThan(0);
});

test("preset feedback sends configured instruction and can be resolved", async ({ page }) => {
    await select(page, "second paragraph");
    await page.getByRole("button", { name: "Provide more context", exact: true }).click();
    await expect(page.locator("#comments")).toContainText("Provide more context");
    expect(sent.at(-1)).toContain("Do not invent facts");
    const card = page.locator(".comment").filter({ has: page.locator("strong", { hasText: "Provide more context" }) }).first();
    await card.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(card.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator(".comment.resolved")).toHaveCount(1);
});

test("diagram comments target Mermaid source instead of SVG labels", async ({ page }) => {
    await page.getByRole("button", { name: "Comment on diagram" }).click();
    await expect(page.locator("#selection")).toContainText("```mermaid");
    await page.getByRole("button", { name: "Rewrite", exact: true }).click();
    await expect(page.locator("#comments")).toContainText("flowchart LR");
    expect(sent.at(-1)).toContain("A[Select] --> B[Comment]");
});

test("rejects stale selections and refreshes external file edits", async ({ page }) => {
    const count = sent.length;
    await select(page);
    await writeFile(path, `${source}\nNew content from an external edit.\n`);
    await page.getByRole("button", { name: "Fix this slop", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("document changed");
    expect(sent.length).toBe(count);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator("#document")).toContainText("New content from an external edit.");
    await writeFile(path, `${source}\nAutomatic refresh works.\n`);
    await expect(page.locator("#document")).toContainText("Automatic refresh works.", { timeout: 10000 });
});

test("comments survive reopening the same document in a fresh server instance", async ({ page }) => {
    const reopened = await startServer({ path, store });
    try {
        await page.goto(reopened.url);
        await expect(page.locator("#comments")).toContainText("Use a simpler term.");
    } finally {
        await reopened.close();
    }
});

test("captures a selection spanning formatting and multiple paragraphs", async ({ page }) => {
    await page.locator("#document").evaluate((article) => {
        const strong = article.querySelector("strong").firstChild;
        const paragraph = article.querySelectorAll("p")[1].firstChild;
        const range = document.createRange();
        range.setStart(strong, 0);
        range.setEnd(paragraph, 10);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
    });
    await expect(page.locator("#selection")).toContainText("formatted");
    await expect(page.locator("#selection")).toContainText("The second");
    await page.getByRole("button", { name: "Rewrite", exact: true }).click();
    await expect(page.locator("#comments .comment").first()).toContainText("The second");
    expect(sent.at(-1)).toContain('"first": 3');
    expect(sent.at(-1)).toContain('"last": 5');
    expect(sent.at(-1)).toContain('"prefix": "A "');
});

test("shows invalid Mermaid errors while keeping its source commentable", async ({ page }) => {
    await writeFile(path, "# Broken diagram\n\n```mermaid\nnot a valid diagram\n```\n");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator("#document .error")).toContainText("Mermaid could not render");
    await page.getByRole("button", { name: "Comment on diagram" }).click();
    await expect(page.locator("#selection")).toContainText("not a valid diagram");
});
