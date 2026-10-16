import DOMPurify from "dompurify";
import mermaid from "mermaid";

mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "neutral", htmlLabels: false, flowchart: { htmlLabels: false } });
const $ = (selector) => document.querySelector(selector);
const article = $("#document");
const margin = $("#margin");
const surface = $("#review-surface");
const composer = $("#composer");
const toolbar = $("#selection-toolbar");
let state;
let selected;
let draftOpen = false;
let retargetId;
let activeId;
let showResolved = false;
let busy = false;
let refreshing = false;
let diagramId = 0;
let lastComments = "";
let layoutFrame;
const lastAnchorPositions = new Map();

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
    $("#cancel-comment").disabled = busy;
    $("#refresh").disabled = busy;
    for (const button of $("#presets").children) button.disabled = busy || !selected;
    for (const button of $("#comments").querySelectorAll("button")) button.disabled = busy;
}

function sourceElement(node) {
    return (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest("[data-start-line]");
}

function rangeAt(startOffset, endOffset) {
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let start;
    while (walker.nextNode()) {
        const node = walker.currentNode;
        const end = offset + node.textContent.length;
        if (!start && startOffset >= offset && startOffset < end) start = { node, offset: startOffset - offset };
        if (start && endOffset <= end) {
            const range = document.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(node, endOffset - offset);
            return range;
        }
        offset = end;
    }
}

function commentRange(comment) {
    if (comment.kind === "diagram") return;
    if (comment.revision === state.revision) {
        const range = rangeAt(comment.startOffset, comment.endOffset);
        return range?.toString() === comment.quote ? range : undefined;
    }
    // Reattach only an unchanged, unambiguous quote; changed passages stay unlinked.
    const text = article.textContent;
    const matches = [];
    let offset = text.indexOf(comment.quote);
    while (offset !== -1) {
        const prefix = comment.anchor?.prefix ?? "";
        const suffix = comment.anchor?.suffix ?? "";
        if (text.slice(0, offset).endsWith(prefix) && text.slice(offset + comment.quote.length).startsWith(suffix)) {
            const range = rangeAt(offset, offset + comment.quote.length);
            if (range && !sourceElement(range.startContainer)?.closest("figure")) matches.push(range);
        }
        if (matches.length > 1) return;
        offset = text.indexOf(comment.quote, offset + 1);
    }
    return matches[0];
}

function anchorFor(comment) {
    if (comment.kind !== "diagram") return commentRange(comment);
    const figures = [...article.querySelectorAll("figure[data-start-line]")];
    const matches = figures.filter((figure) => {
        const source = state.source.split("\n").slice(Number(figure.dataset.startLine), Number(figure.dataset.endLine)).join("\n");
        return source === comment.quote;
    });
    if (comment.revision === state.revision) return matches.find((figure) => Number(figure.dataset.startLine) === comment.startLine);
    return matches.length === 1 ? matches[0] : undefined;
}

function anchorRect(anchor, last = false) {
    if (!anchor) return;
    const rects = [...anchor.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    return last ? rects.at(-1) : rects[0];
}

function setSelection(value) {
    selected = value;
    $("#selection").textContent = value?.quote ?? "";
    toolbar.hidden = !value || draftOpen;
    controls();
    highlightComments();
    scheduleLayout();
}

function captureSelection() {
    if (busy || !state || draftOpen) return;
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) {
        if (!toolbar.contains(document.activeElement)) setSelection(undefined);
        return;
    }
    const range = selection.getRangeAt(0);
    if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) return;
    const start = sourceElement(range.startContainer);
    const end = sourceElement(range.endContainer);
    if (!start || !end) return;
    if (range.cloneContents().querySelector("svg") || start.closest("figure") || end.closest("figure")) {
        setSelection(undefined);
        notice('Use "Comment on diagram" to select a Mermaid diagram.', true);
        return;
    }
    setSelection(selectionFromRange(range));
    notice(retargetId ? 'Choose New comment to resubmit the original feedback on this passage.' :
        "Choose New comment, or press Ctrl+Alt+M, to comment beside this passage.");
}

function selectionFromRange(range) {
    const start = sourceElement(range.startContainer);
    const end = sourceElement(range.endContainer);
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
    return {
        kind: "text", revision: state.revision, quote, startOffset, endOffset: startOffset + quote.length,
        anchor: {
            startBlockOffset: blockBefore.toString().length,
            endBlockOffset: end.textContent.length - blockAfter.toString().length,
            prefix: blockBefore.toString().slice(-160), suffix: blockAfter.toString().slice(0, 160),
        },
        startLine: Math.min(Number(start.dataset.startLine), Number(end.dataset.startLine)),
        endLine: Math.max(Number(start.dataset.endLine), Number(end.dataset.endLine)),
    };
}

function selectionFor(comment) {
    const anchor = anchorFor(comment);
    if (!anchor) return;
    if (anchor instanceof Range) return selectionFromRange(anchor);
    const startLine = Number(anchor.dataset.startLine);
    const endLine = Number(anchor.dataset.endLine);
    const quote = state.source.split("\n").slice(startLine, endLine).join("\n");
    return { kind: "diagram", revision: state.revision, quote, startLine, endLine, startOffset: 0, endOffset: quote.length };
}

function openDraft() {
    if (!selected || busy) return;
    draftOpen = true;
    const original = state.comments.find((comment) => comment.id === retargetId);
    $("#feedback").value = original?.instruction ?? "";
    $("#feedback").readOnly = Boolean(original);
    $("#presets").hidden = Boolean(original);
    $("#send").textContent = original ? "Resubmit feedback" : "Post comment";
    activeId = undefined;
    for (const card of $("#comments").children) card.classList.remove("active");
    composer.hidden = false;
    toolbar.hidden = true;
    $("#empty-comments").hidden = true;
    highlightComments();
    layoutComments();
    composer.scrollIntoView({ block: "nearest", inline: "nearest" });
    $("#feedback").focus({ preventScroll: true });
}

function closeDraft() {
    draftOpen = false;
    composer.hidden = true;
    $("#feedback").value = "";
    retargetId = undefined;
    setSelection(undefined);
    window.getSelection().removeAllRanges();
    $("#empty-comments").hidden = visibleComments().length > 0;
}

document.addEventListener("selectionchange", captureSelection);
toolbar.addEventListener("pointerdown", (event) => event.preventDefault());
$("#new-comment").addEventListener("click", openDraft);
$("#cancel-comment").addEventListener("click", closeDraft);
document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === "m") {
        captureSelection();
        if (selected) {
            event.preventDefault();
            openDraft();
        }
    } else if (event.key === "Escape" && !busy) {
        if (draftOpen || selected || retargetId) {
            event.preventDefault();
            closeDraft();
        }
    } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && draftOpen) {
        event.preventDefault();
        $("#feedback-form").requestSubmit();
    }
});

article.addEventListener("contextmenu", (event) => {
    captureSelection();
    if (selected && !draftOpen) {
        event.preventDefault();
        positionToolbar(event.clientX, event.clientY);
    }
});
article.addEventListener("click", (event) => {
    const button = event.target.closest(".diagram-comment");
    if (button && state && !busy) {
        if (draftOpen) return notice("Post or cancel the current comment before starting another.");
        const figure = button.closest("figure");
        const startLine = Number(figure.dataset.startLine);
        const endLine = Number(figure.dataset.endLine);
        const quote = state.source.split("\n").slice(startLine, endLine).join("\n");
        setSelection({ kind: "diagram", revision: state.revision, quote, startLine, endLine, startOffset: 0, endOffset: quote.length });
        openDraft();
        return;
    }
    if (!window.getSelection().isCollapsed) return;
    for (const comment of visibleComments()) {
        const anchor = anchorFor(comment);
        if (!anchor) continue;
        if ([...anchor.getClientRects()].some((rect) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)) {
            activateComment(comment, "card");
            return;
        }
    }
});

async function send(input) {
    if (!selected || busy) return;
    busy = true;
    controls();
    try {
        const comment = retargetId ?
            await api("reopen", { id: retargetId, retarget: true, selection: selected }) :
            await api("comments", { ...selected, ...input });
        activeId = comment.id;
        closeDraft();
        await refresh();
        notice("Comment posted and sent to Copilot. The preview updates when the file changes.");
    } catch (error) {
        if (retargetId) {
            closeDraft();
            try {
                await refresh();
            } catch (refreshError) {
                notice(`${error.message} Refresh also failed: ${refreshError.message}`, true);
                return;
            }
        }
        notice(error.message, true);
    } finally {
        busy = false;
        controls();
    }
}

$("#feedback-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!$("#feedback").value.trim()) return notice("Enter feedback before posting.", true);
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

function visibleComments() {
    return (state?.comments ?? []).filter((comment) => showResolved || (!comment.resolved && !comment.reopenedAs));
}

function retarget(comment) {
    if (busy) return;
    if (draftOpen) return notice("Post or cancel the current comment before selecting another passage.");
    closeDraft();
    retargetId = comment.id;
    notice("Select the current passage, then choose New comment to resubmit the original feedback. Nothing has been sent yet.");
}

async function reopen(comment) {
    if (busy) return;
    const selection = selectionFor(comment);
    if (!selection || !comment.canReopen) return retarget(comment);
    busy = true;
    controls();
    renderComments();
    try {
        const next = await api("reopen", { id: comment.id, selection });
        activeId = next.id;
        await refresh();
        notice(next.status === "sent" ? "Feedback reopened and sent to Copilot." :
            "Feedback was not sent. Check its delivery status.", next.status !== "sent");
    } catch (error) {
        try {
            await refresh();
        } catch (refreshError) {
            notice(`${error.message} Refresh also failed: ${refreshError.message}`, true);
            return;
        }
        notice(error.message, true);
    } finally {
        busy = false;
        controls();
        renderComments();
    }
}

function activateComment(comment, focus = "passage") {
    activeId = comment.id;
    const card = document.getElementById(`comment-${comment.id}`);
    for (const item of $("#comments").children) item.classList.toggle("active", item === card);
    highlightComments();
    scheduleLayout();
    const anchor = anchorFor(comment);
    if (focus === "card") {
        card?.focus({ preventScroll: true });
        card?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    } else if (anchor) {
        const target = anchor instanceof Range ? sourceElement(anchor.startContainer) : anchor;
        target?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    } else {
        notice("The original passage changed or is ambiguous. This comment is preserved but is no longer linked to text.");
    }
}

function renderComments() {
    const comments = visibleComments();
    const resolved = state.comments.filter((comment) => comment.resolved || comment.reopenedAs).length;
    $("#count").textContent = `(${state.comments.length - resolved} open)`;
    $("#show-resolved").hidden = resolved === 0;
    $("#show-resolved").textContent = `${showResolved ? "Hide" : "Show"} resolved / history (${resolved})`;
    $("#show-resolved").setAttribute("aria-pressed", String(showResolved));
    $("#empty-comments").hidden = draftOpen || comments.length > 0;
    $("#comments").replaceChildren(...comments.map((comment) => {
        const linked = Boolean(anchorFor(comment));
        const card = document.createElement("section");
        card.id = `comment-${comment.id}`;
        card.dataset.commentId = comment.id;
        card.className = `comment${comment.resolved ? " resolved" : ""}${activeId === comment.id ? " active" : ""}${linked ? "" : " outdated"}`;
        card.tabIndex = 0;
        card.setAttribute("aria-label", `${comment.label} comment`);
        card.addEventListener("focus", () => activateComment(comment));
        card.addEventListener("click", (event) => {
            if (!event.target.closest("button")) activateComment(comment);
        });
        const heading = document.createElement("div");
        heading.className = "comment-heading";
        const avatar = document.createElement("span");
        avatar.className = "avatar";
        avatar.textContent = "Y";
        avatar.setAttribute("aria-hidden", "true");
        const author = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = "You";
        const time = document.createElement("small");
        time.textContent = new Date(comment.createdAt).toLocaleString();
        author.append(name, time);
        heading.append(avatar, author);
        const label = document.createElement("strong");
        label.className = "comment-label";
        label.textContent = comment.label;
        const quote = document.createElement("blockquote");
        quote.textContent = comment.quote;
        const feedback = document.createElement("p");
        feedback.className = "comment-feedback";
        feedback.textContent = comment.instruction;
        const meta = document.createElement("small");
        meta.className = "comment-source";
        const location = !linked ? "Original passage changed - unlinked" : comment.revision !== state.revision ? "Passage unchanged - document updated" : `Lines ${comment.startLine + 1}-${comment.endLine}`;
        meta.textContent = `${location} | ${comment.status}`;
        const actions = document.createElement("div");
        actions.className = "comment-actions";
        if (comment.reopenedAs) {
            const history = document.createElement("small");
            history.textContent = "Preserved history - feedback resubmitted";
            actions.append(history);
        } else if (comment.resolved || comment.status === "failed") {
            const button = document.createElement("button");
            button.textContent = comment.resolved ? "Reopen" : "Retry";
            button.disabled = busy;
            button.addEventListener("click", () => void reopen(comment));
            actions.append(button);
        } else if (linked) {
            const waiting = document.createElement("small");
            waiting.textContent = comment.status === "sent" ? "Waiting for Copilot to resolve" : "Not yet resolved";
            actions.append(waiting);
        }
        let retargetHint;
        if (!comment.reopenedAs && comment.status !== "pending" && (!linked || !comment.canReopen) &&
            (comment.resolved || !linked || comment.status === "failed")) {
            const hint = document.createElement("p");
            hint.textContent = "Select the current passage to resubmit the original feedback. Copilot will not guess which changed passage to edit.";
            retargetHint = hint;
            const button = document.createElement("button");
            button.textContent = "Select current passage";
            button.disabled = busy;
            button.addEventListener("click", () => retarget(comment));
            actions.append(button);
        }
        card.append(heading, label, quote, feedback, meta);
        if (retargetHint) card.append(retargetHint);
        if (comment.error || comment.status === "pending") {
            const error = document.createElement("p");
            error.className = "error";
            error.textContent = comment.error ?? "Delivery unconfirmed. Check the conversation before submitting again.";
            card.append(error);
        }
        card.append(actions);
        return card;
    }));
    resizeObserver.disconnect();
    for (const element of [article, composer, $(".margin-heading"), ...$("#comments").children]) resizeObserver.observe(element);
    highlightComments();
    scheduleLayout();
}

$("#show-resolved").addEventListener("click", () => {
    showResolved = !showResolved;
    renderComments();
});

function highlightComments() {
    if (!state) return;
    const comments = visibleComments();
    for (const figure of article.querySelectorAll(".comment-anchor")) figure.classList.remove("comment-anchor");
    const active = comments.find((comment) => comment.id === activeId);
    const draftAnchor = selected && anchorFor(selected);
    const activeAnchor = active && anchorFor(active);
    for (const anchor of [draftAnchor, activeAnchor]) {
        if (anchor instanceof Element) anchor.classList.add("comment-anchor");
    }
    if (!globalThis.CSS?.highlights) return;
    const ranges = comments.filter((comment) => !comment.resolved && !comment.reopenedAs).map(commentRange).filter(Boolean);
    CSS.highlights.set("review-comments", new Highlight(...ranges));
    CSS.highlights.set("review-active", new Highlight(...(activeAnchor instanceof Range ? [activeAnchor] : [])));
    CSS.highlights.set("review-draft", new Highlight(...(draftAnchor instanceof Range ? [draftAnchor] : [])));
}

function positionToolbar(x, y) {
    if (toolbar.hidden || !selected) return;
    const rect = anchorRect(anchorFor(selected), true);
    if (!rect) return;
    const left = x ?? rect.left;
    const top = y ?? rect.bottom + 6;
    toolbar.style.left = `${scrollX + Math.max(8, Math.min(left, innerWidth - toolbar.offsetWidth - 8))}px`;
    toolbar.style.top = `${scrollY + Math.max(8, Math.min(top, innerHeight - toolbar.offsetHeight - 8))}px`;
}

function scheduleLayout() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
        layoutFrame = undefined;
        layoutComments();
    });
}

function layoutComments() {
    if (!state) return;
    const surfaceRect = surface.getBoundingClientRect();
    const marginRect = margin.getBoundingClientRect();
    const articleRect = article.getBoundingClientRect();
    const minimum = $(".margin-heading").offsetHeight + 16;
    const entries = visibleComments().map((comment) => ({
        card: document.getElementById(`comment-${comment.id}`), anchor: anchorFor(comment), id: comment.id,
    }));
    if (draftOpen && selected) entries.unshift({ card: composer, anchor: anchorFor(selected), id: "draft" });
    for (const entry of entries) {
        entry.rect = anchorRect(entry.anchor);
        if (entry.rect) lastAnchorPositions.set(entry.id, entry.rect.top - marginRect.top);
        entry.top = lastAnchorPositions.get(entry.id) ?? Infinity;
    }
    entries.sort((a, b) => a.top - b.top);
    const priority = entries.find((entry) => entry.id === (draftOpen ? "draft" : activeId));
    if (priority) {
        entries.splice(entries.indexOf(priority), 1);
        entries.unshift(priority);
    }
    let bottom = minimum;
    const occupied = [];
    const svg = $("#connectors");
    svg.replaceChildren();
    for (const entry of entries) {
        const desired = Math.max(minimum, Number.isFinite(entry.top) ? entry.top : bottom);
        const height = entry.card.offsetHeight;
        let top;
        let distance = Infinity;
        let gapStart = minimum;
        const fit = (gapEnd) => {
            if (gapEnd - gapStart < height) return;
            const candidate = Math.max(gapStart, Math.min(desired, gapEnd - height));
            if (Math.abs(candidate - desired) < distance) {
                top = candidate;
                distance = Math.abs(candidate - desired);
            }
        };
        for (const interval of occupied) {
            fit(interval.top - 12);
            gapStart = interval.bottom + 12;
        }
        fit(Infinity);
        entry.card.style.top = `${top}px`;
        const end = top + height;
        occupied.push({ top, bottom: end });
        occupied.sort((a, b) => a.top - b.top);
        bottom = Math.max(bottom, end + 12);
        if (!entry.rect) continue;
        const x1 = articleRect.right - surfaceRect.left;
        const y1 = entry.rect.top + Math.min(entry.rect.height / 2, 12) - surfaceRect.top;
        const x2 = marginRect.left - surfaceRect.left;
        const y2 = marginRect.top + top + 26 - surfaceRect.top;
        const active = entry.id === activeId || entry.id === "draft";
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", `M ${x1} ${y1} C ${x1 + 14} ${y1}, ${x2 - 14} ${y2}, ${x2} ${y2}`);
        path.dataset.commentId = entry.id;
        path.classList.toggle("active", active);
        const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        dot.setAttribute("cx", x1);
        dot.setAttribute("cy", y1);
        dot.setAttribute("r", "3");
        dot.classList.toggle("active", active);
        svg.append(path, dot);
    }
    margin.style.minHeight = `${Math.max(articleRect.height, bottom)}px`;
    svg.setAttribute("width", surface.clientWidth);
    svg.setAttribute("height", surface.clientHeight);
    positionToolbar();
}

const resizeObserver = new ResizeObserver(scheduleLayout);
window.addEventListener("resize", scheduleLayout);
window.addEventListener("scroll", scheduleLayout, { passive: true, capture: true });
article.addEventListener("toggle", scheduleLayout, true);

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
            closeDraft();
            article.innerHTML = DOMPurify.sanitize(state.html, { ADD_ATTR: ["target"] });
            await diagrams();
            notice("Select a passage, then choose New comment. Comments stay beside the text they refer to.");
        }
        if (promptsChanged) renderPrompts(state.prompts);
        const commentData = JSON.stringify(state.comments);
        if (commentData !== lastComments || changed) {
            lastComments = commentData;
            renderComments();
        }
    } finally {
        refreshing = false;
    }
}

$("#refresh").addEventListener("click", () => void refresh().catch((error) => notice(error.message, true)));
await refresh().catch((error) => notice(error.message, true));
setInterval(() => {
    if (!selected && !busy && !document.hidden) void refresh().catch((error) => notice(error.message, true));
}, 2000);
