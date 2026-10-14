import DOMPurify from "dompurify";
import mermaid from "mermaid";

mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "neutral", htmlLabels: false, flowchart: { htmlLabels: false } });
const $ = (selector) => document.querySelector(selector);
const article = $("#document");
let state;
let selected;
let busy = false;
let refreshing = false;
let diagramId = 0;
let lastComments = "";

function notice(message, error = false) {
    $("#notice").textContent = message;
    $("#notice").classList.toggle("error", error);
}

async function api(route, input) {
    const response = await fetch(new URL(route, location.href), input === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status}).`);
    return result;
}

function controls() {
    $("#send").disabled = busy || !selected;
    for (const button of $("#presets").children) button.disabled = busy || !selected;
}

function setSelection(value) {
    selected = value;
    $("#selection").textContent = value?.quote ?? "No passage selected.";
    controls();
}

function sourceElement(node) {
    return (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest("[data-start-line]");
}

function captureSelection() {
    if (busy || !state) return;
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) return;
    const start = sourceElement(range.startContainer);
    const end = sourceElement(range.endContainer);
    if (!start || !end) return;
    // Generated SVG labels cannot be mapped to Markdown text offsets reliably.
    if (range.cloneContents().querySelector("svg") || range.startContainer.parentElement?.closest("figure") || range.endContainer.parentElement?.closest("figure")) {
        notice('Use "Comment on diagram" to select a Mermaid diagram.', true);
        return;
    }
    const before = document.createRange();
    before.selectNodeContents(article);
    before.setEnd(range.startContainer, range.startOffset);
    const startOffset = before.toString().length;
    const quote = range.toString();
    if (!quote.trim()) return;
    const blockBefore = document.createRange();
    blockBefore.selectNodeContents(start);
    blockBefore.setEnd(range.startContainer, range.startOffset);
    const blockAfter = document.createRange();
    blockAfter.selectNodeContents(end);
    blockAfter.setStart(range.endContainer, range.endOffset);
    const startBlockOffset = blockBefore.toString().length;
    const endBlockOffset = end.textContent.length - blockAfter.toString().length;
    setSelection({
        kind: "text", revision: state.revision, quote, startOffset, endOffset: startOffset + quote.length,
        anchor: {
            startBlockOffset, endBlockOffset,
            prefix: blockBefore.toString().slice(-160), suffix: blockAfter.toString().slice(0, 160),
        },
        startLine: Math.min(Number(start.dataset.startLine), Number(end.dataset.startLine)),
        endLine: Math.max(Number(start.dataset.endLine), Number(end.dataset.endLine)),
    });
    notice("Passage selected. Choose feedback or enter a custom comment.");
}

document.addEventListener("selectionchange", captureSelection);
article.addEventListener("click", (event) => {
    const button = event.target.closest(".diagram-comment");
    if (!button || !state || busy) return;
    const figure = button.closest("figure");
    const startLine = Number(figure.dataset.startLine);
    const endLine = Number(figure.dataset.endLine);
    const quote = state.source.split("\n").slice(startLine, endLine).join("\n");
    setSelection({ kind: "diagram", revision: state.revision, quote, startLine, endLine, startOffset: 0, endOffset: quote.length });
    notice("Diagram selected. Feedback will target its Mermaid source.");
    $("#feedback").focus();
});

async function send(input) {
    if (!selected || busy) return;
    busy = true;
    controls();
    try {
        await api("comments", { ...selected, ...input });
        setSelection(undefined);
        $("#feedback").value = "";
        notice("Feedback sent to Copilot. Edits appear here when the file changes; sending does not mean the edit is finished.");
        await refresh();
    } catch (error) {
        notice(error.message, true);
    } finally {
        busy = false;
        controls();
    }
}

$("#feedback-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!$("#feedback").value.trim()) return notice("Enter feedback before sending.", true);
    void send({ prompt: $("#feedback").value });
});

function renderPrompts(prompts) {
    $("#presets").replaceChildren(...prompts.map((preset) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = preset.label;
        button.title = preset.prompt;
        button.addEventListener("click", () => void send({ promptId: preset.id }));
        return button;
    }));
    controls();
}

function renderComments(comments) {
    $("#count").textContent = `(${comments.length})`;
    $("#comments").replaceChildren(...comments.toReversed().map((comment) => {
        const card = document.createElement("section");
        card.className = `comment${comment.resolved ? " resolved" : ""}`;
        card.tabIndex = 0;
        card.addEventListener("focus", () => revealComment(comment));
        card.addEventListener("click", (event) => {
            if (!event.target.closest("button")) revealComment(comment);
        });
        const heading = document.createElement("strong");
        heading.textContent = comment.label;
        const quote = document.createElement("blockquote");
        quote.textContent = comment.quote;
        const feedback = document.createElement("p");
        feedback.textContent = comment.instruction;
        const meta = document.createElement("small");
        const outdated = comment.revision !== state.revision ? " | Earlier document revision" : "";
        meta.textContent = `Lines ${comment.startLine + 1}-${comment.endLine} | ${comment.status}${outdated} | ${new Date(comment.createdAt).toLocaleString()}`;
        const button = document.createElement("button");
        button.textContent = comment.resolved ? "Reopen" : "Resolve";
        button.addEventListener("click", async () => {
            button.disabled = true;
            try {
                await api("resolve", { id: comment.id, resolved: !comment.resolved });
                await refresh();
            } catch (error) {
                notice(error.message, true);
                button.disabled = false;
            }
        });
        card.append(heading, quote, feedback, meta);
        if (comment.error) {
            const error = document.createElement("p");
            error.className = "error";
            error.textContent = comment.error;
            card.append(error);
        }
        if (comment.status === "pending") {
            const pending = document.createElement("p");
            pending.textContent = "Delivery unconfirmed. If the extension restarted, check the conversation before submitting again.";
            card.append(pending);
        }
        card.append(button);
        return card;
    }));
    highlightComments(comments);
}

function commentRange(comment) {
    if (comment.kind === "diagram" || comment.revision !== state.revision) return;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let start;
    while (walker.nextNode()) {
        const node = walker.currentNode;
        const end = offset + node.textContent.length;
        if (!start && comment.startOffset >= offset && comment.startOffset < end) {
            start = { node, offset: comment.startOffset - offset };
        }
        if (start && comment.endOffset <= end) {
            const range = document.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(node, comment.endOffset - offset);
            return range.toString() === comment.quote ? range : undefined;
        }
        offset = end;
    }
}

function highlightComments(comments) {
    if (!globalThis.CSS?.highlights) return;
    const ranges = comments.filter((comment) => !comment.resolved).map(commentRange).filter(Boolean);
    CSS.highlights.set("review-comments", new Highlight(...ranges));
}

function revealComment(comment) {
    if (comment.revision !== state.revision) return notice("This comment targets an earlier document revision. Its original quote is preserved in the sidebar.");
    const range = commentRange(comment);
    const target = range ? sourceElement(range.startContainer) : article.querySelector(`figure[data-start-line="${comment.startLine}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function diagrams() {
    for (const source of article.querySelectorAll(".mermaid-source")) {
        try {
            const { svg } = await mermaid.render(`diagram-${diagramId++}`, source.textContent);
            const output = document.createElement("div");
            output.className = "mermaid";
            output.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
            source.before(output);
            const details = document.createElement("details");
            const summary = document.createElement("summary");
            summary.textContent = "Mermaid source";
            details.append(summary);
            source.before(details);
            details.append(source);
        } catch (error) {
            const message = document.createElement("p");
            message.className = "error";
            message.textContent = `Mermaid could not render: ${error.message}`;
            source.before(message);
        }
    }
}

async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
        const next = await api("state");
        const changed = state?.revision !== next.revision;
        const promptsChanged = JSON.stringify(state?.prompts) !== JSON.stringify(next.prompts);
        state = next;
        $("#title").textContent = state.title;
        $("#path").textContent = state.path;
        if (changed) {
            setSelection(undefined);
            article.innerHTML = DOMPurify.sanitize(state.html, { ADD_ATTR: ["target"] });
            await diagrams();
            notice("Select a passage to request an edit. Document updates automatically.");
        }
        if (promptsChanged) renderPrompts(state.prompts);
        const commentData = JSON.stringify(state.comments);
        if (commentData !== lastComments || changed) {
            lastComments = commentData;
            renderComments(state.comments);
        }
    } finally {
        refreshing = false;
    }
}

$("#refresh").addEventListener("click", () => void refresh().catch((error) => notice(error.message, true)));
await refresh().catch((error) => notice(error.message, true));
setInterval(() => {
    // Preserve a pending selection while the user writes; stale submissions are rejected.
    if (!selected && !busy && !document.hidden) void refresh().catch((error) => notice(error.message, true));
}, 2000);
