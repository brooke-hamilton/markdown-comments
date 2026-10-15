import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { startServer } from "./server.mjs";
import { ReviewStore } from "./review.mjs";

const servers = new Map();
let session;
const store = new ReviewStore({
    send: (prompt, displayPrompt) => session.send({ prompt, displayPrompt }),
});

function instance(ctx) {
    const entry = servers.get(ctx.instanceId);
    if (!entry) throw new CanvasError("document_not_open", "Open a document first.");
    return entry;
}

session = await joinSession({
    tools: [
        {
            name: "markdown_comments_resolve_comment",
            description: "Resolve a Markdown canvas comment after completing and verifying its requested file edit. Never resolve blocked or unfinished feedback.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Absolute Markdown file path from the review request." },
                    commentId: { type: "string", description: "Comment ID from the review request." },
                },
                required: ["path", "commentId"],
                additionalProperties: false,
            },
            handler: async ({ path, commentId }) => {
                try {
                    return JSON.stringify(await store.complete(path, commentId));
                } catch (error) {
                    return { resultType: "failure", textResultForLlm: error.message };
                }
            },
        },
    ],
    canvases: [
        createCanvas({
            id: "markdown-comments",
            displayName: "Markdown comments",
            description: "Review a local Markdown document with rendered Mermaid and selection-based feedback sent to Copilot.",
            inputSchema: {
                type: "object",
                properties: { path: { type: "string", minLength: 1, description: "Absolute path to a Markdown file." } },
                required: ["path"],
                additionalProperties: false,
            },
            actions: [
                {
                    name: "refresh",
                    description: "Reload the document and configured feedback prompts from disk.",
                    handler: (ctx) => store.state(instance(ctx).path),
                },
                {
                    name: "list_comments",
                    description: "Read saved review comments and their delivery status for this document.",
                    handler: async (ctx) => (await store.state(instance(ctx).path)).comments,
                },
            ],
            open: async (ctx) => {
                const state = await store.state(ctx.input.path);
                let entry = servers.get(ctx.instanceId);
                if (entry && entry.path !== state.path) {
                    await entry.close();
                    servers.delete(ctx.instanceId);
                    entry = undefined;
                }
                if (!entry) {
                    entry = await startServer({ path: state.path, store });
                    servers.set(ctx.instanceId, entry);
                }
                return { title: state.title, url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await entry.close();
                }
            },
        }),
    ],
});
