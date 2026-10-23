import DOMPurify from "dompurify";
import mermaid from "mermaid";
import { createMarkdownEditor } from "./editor.mjs";

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
let editor;
let externalChanged = false;
let saving;
let saveTimer;
let saveError;
let dirtySince;
const lastAnchorPositions = new Map();

function notice(message, error = false) {
    $("#notice").textContent = message;
    $("#notice").hidden = !message;
    $("#notice").classList.toggle("error", error);
}

async function api(route, input) {
    const response = await fetch(new URL(route, location.href), input === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    const result = await response.json();
    if (!response.ok) {
        const error = new Error(result.error ?? `Request failed (${response.status}).`);
        error.status = response.status;
        throw error;
    }
    return result;
}

function controls() {
    $("#send").disabled = busy || !selected;
    $("#cancel-comment").disabled = busy;
    for (const button of $("#presets").children) button.disabled = busy || !selected;
    for (const button of $("#comments").querySelectorAll("button")) button.disabled = busy;
    $("#retry-save").hidden = !saveError || externalChanged;
    $("#retry-save").disabled = busy || Boolean(saving);
    $("#reload-document").hidden = !externalChanged;
    $("#reload-document").disabled = busy || Boolean(saving);
    $("#edit-status").textContent = !editor ? "Loading..." : externalChanged ? "Disk changed - local draft preserved" :
        saveError ? "Not saved - retry needed" : saving ? "Saving..." : editor.dirty ? "Unsaved edits - autosaving..." : "Saved";
    editor?.setReadonly(busy || draftOpen);
}

function commentRange(comment) {
    if (comment.kind === "diagram") return;
    return editor?.range(comment.id ?? "draft");
}

function anchorFor(comment) {
    return comment.kind === "diagram" ? editor?.diagramElement(comment.id ?? "draft") : commentRange(comment);
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
    if (busy || !editor || draftOpen) return;
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) {
        if (!toolbar.contains(document.activeElement)) setSelection(undefined);
        return;
    }
    const range = selection.getRangeAt(0);
    if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) return;
    if (range.cloneContents().querySelector("svg, .editor-diagram") || range.startContainer.parentElement?.closest(".editor-diagram") || range.endContainer.parentElement?.closest(".editor-diagram")) {
        setSelection(undefined);
        return notice('Use "Comment on diagram" for a Mermaid preview.', true);
    }
    if (!range.toString().trim()) return setSelection(undefined);
    try {
        editor.selection(range);
        setSelection({ ...editor.selected(), revision: state.revision });
    } catch (error) {
        setSelection(undefined);
        notice(error.message, true);
    }
}

function selectionFor(comment) {
    const anchor = anchorFor(comment);
    if (!anchor) return;
    if (comment.kind === "diagram") return { ...editor.diagramFor(comment.id), revision: state.revision };
    editor.selection(anchor);
    return { ...editor.selected(), revision: state.revision };
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
    controls();
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
    controls();
}

document.addEventListener("selectionchange", captureSelection);
toolbar.addEventListener("pointerdown", (event) => event.preventDefault());
$("#new-comment").addEventListener("click", openDraft);
$("#cancel-comment").addEventListener("click", closeDraft);
document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && editor) {
        event.preventDefault();
        if (!busy) void flushDocument().catch((error) => notice(error.message, true));
    } else if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === "m") {
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

async function send(input) {
    if (!selected || busy) return;
    busy = true;
    controls();
    let submitting = false;
    try {
        if (editor) {
            const diagramPos = selected.diagramPos;
            await flushDocument(true);
            selected = { ...(diagramPos === undefined ? editor.selected() : editor.diagram(diagramPos)), diagramPos, revision: state.revision };
        }
        submitting = true;
        const comment = retargetId ?
            await api("reopen", { id: retargetId, retarget: true, selection: selected }) :
            await api("comments", { ...selected, ...input });
        if (editor) editor.track(comment.id, editor.range("draft"));
        activeId = comment.id;
        closeDraft();
        await refresh();
        notice("Comment posted and sent to Copilot. The document updates automatically.");
    } catch (error) {
        if (retargetId && submitting) {
            closeDraft();
            try {
                await refresh();
            } catch (refreshError) {
                notice(`${error.message} Checking the latest document also failed: ${refreshError.message}`, true);
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
    if (draftOpen) return notice("Post or cancel the current comment before selecting another passage.");
    let selection = selectionFor(comment);
    if (!selection || !comment.canReopen) return retarget(comment);
    busy = true;
    controls();
    renderComments();
    try {
        await flushDocument(true);
        selection = { ...selectionFor(comment), revision: state.revision };
        const next = await api("reopen", { id: comment.id, selection });
        if (editor) editor.track(next.id, editor.range("draft"));
        activeId = next.id;
        await refresh();
        notice(next.status === "sent" ? "Feedback reopened and sent to Copilot." :
            "Feedback was not sent. Check its delivery status.", next.status !== "sent");
    } catch (error) {
        try {
            await refresh();
        } catch (refreshError) {
            notice(`${error.message} Checking the latest document also failed: ${refreshError.message}`, true);
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
        const target = anchor instanceof Range ?
            (anchor.startContainer.nodeType === Node.ELEMENT_NODE ? anchor.startContainer : anchor.startContainer.parentElement) : anchor;
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
        const location = !linked ? "Original passage changed - unlinked" : editor?.dirty ? "Linked in local draft" : comment.revision !== state.revision ? "Passage unchanged - document updated" : `Lines ${comment.startLine + 1}-${comment.endLine}`;
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

async function renderEditorDiagram(output, source) {
    try {
        const { svg } = await mermaid.render(`diagram-${diagramId++}`, source);
        if (output.isConnected) {
            output.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
            scheduleLayout();
        }
    } catch (error) {
        output.classList.add("error");
        output.textContent = `Mermaid could not render: ${error.message}`;
    }
}

function scheduleSave() {
    clearTimeout(saveTimer);
    if (!editor?.dirty || externalChanged || saveError) return;
    dirtySince ??= Date.now();
    saveTimer = setTimeout(() => {
        void flushDocument().catch((error) => notice(error.message, true));
    }, Math.min(600, Math.max(0, 2000 - (Date.now() - dirtySince))));
}

async function flushDocument(checkRevision = false) {
    clearTimeout(saveTimer);
    while (saving) await saving;
    if (!editor) return;
    if (externalChanged) throw new Error("The document changed on disk. Copy your draft before choosing Use disk version to reconcile the changes.");
    if (saveError) throw saveError;
    if (!editor.dirty && !checkRevision) return;
    const checkpoint = editor.snapshot();
    const currentEditor = editor;
    const task = (async () => {
        try {
            const saved = await api("document", { revision: state.revision, source: checkpoint.source });
            state = { ...state, ...saved };
            currentEditor.accept(saved, checkpoint);
            dirtySince = undefined;
        } catch (error) {
            saveError = error;
            if (error.status === 409) externalChanged = true;
            throw error;
        }
    })();
    saving = task;
    controls();
    try { await task; }
    finally {
        if (saving === task) saving = undefined;
        controls();
        renderComments();
        scheduleSave();
    }
    // Typing can continue during autosave; feedback must refer to the newest saved draft.
    if (checkRevision && editor.dirty) await flushDocument(true);
}

function trackComments() {
    for (const comment of state.comments) {
        if (editor.hasAnchor(comment.id)) continue;
        if (comment.kind === "diagram") editor.trackDiagram(comment, state.revision);
        else editor.trackText(comment, state.revision);
    }
}

function applyDisk(next) {
    clearTimeout(saveTimer);
    editor.replace(next.source, next.editing);
    state = next;
    externalChanged = false;
    saveError = undefined;
    dirtySince = undefined;
    setSelection(undefined);
    trackComments();
    captureSelection();
    notice("Document updated from disk. Changes are saved automatically.");
}

$("#retry-save").addEventListener("click", () => {
    saveError = undefined;
    void flushDocument().then(() => notice("Changes saved automatically.")).catch((error) => notice(error.message, true));
});
$("#reload-document").addEventListener("click", async () => {
    if ((editor?.dirty || draftOpen) && !window.confirm("Discard your unsaved document edits and comment draft and use the current disk version? Copy your draft first if you need it.")) return;
    busy = true;
    controls();
    try {
        const next = await api("state");
        closeDraft();
        applyDisk(next);
        renderPrompts(next.prompts);
        renderComments();
    } catch (error) { notice(error.message, true); }
    finally { busy = false; controls(); }
});
window.addEventListener("beforeunload", (event) => {
    if (editor?.dirty) { event.preventDefault(); event.returnValue = ""; }
});
document.addEventListener("visibilitychange", () => {
    if (document.hidden) void flushDocument().catch((error) => notice(error.message, true));
});

async function refresh() {
    if (refreshing || saving) return;
    refreshing = true;
    try {
        const revision = state?.revision;
        const next = await api("state");
        // A save may have started while the read was in flight. Never apply that stale response.
        if (saving || state?.revision !== revision) return;
        const changed = state?.revision !== next.revision;
        const promptsChanged = JSON.stringify(state?.prompts) !== JSON.stringify(next.prompts);
        if (!editor) {
            state = next;
            $("#title").textContent = state.title;
            $("#path").textContent = state.path;
            article.classList.add("editing");
            editor = await createMarkdownEditor({
                root: article, source: state.source, editing: state.editing,
                onError: (error) => notice(error.message, true),
                renderDiagram: renderEditorDiagram,
                onDiagram: (pos) => {
                    if (busy || draftOpen) return;
                    try {
                        setSelection({ ...editor.diagram(pos), diagramPos: pos, revision: state.revision });
                        openDraft();
                    } catch (error) { notice(error.message, true); }
                },
                onChange: () => {
                    if (!editor) return;
                    if (!draftOpen) setSelection(undefined);
                    controls();
                    renderComments();
                    scheduleSave();
                },
            });
        } else if (changed) {
            if (editor.dirty || draftOpen || busy) {
                externalChanged = true;
                clearTimeout(saveTimer);
                notice("The document changed on disk. Your local draft and comment are preserved. Copy your draft or choose Use disk version to reconcile the changes.", true);
            } else {
                applyDisk(next);
            }
        } else if (externalChanged) {
            externalChanged = false;
            saveError = undefined;
            scheduleSave();
        }
        state.comments = next.comments;
        state.prompts = next.prompts;
        trackComments();
        if (promptsChanged) renderPrompts(state.prompts);
        const commentData = JSON.stringify(state.comments);
        if (commentData !== lastComments || changed) {
            lastComments = commentData;
            renderComments();
        }
        controls();
    } finally {
        refreshing = false;
    }
}

await refresh().catch((error) => notice(error.message, true));
setInterval(() => {
    if (!busy && !document.hidden) void refresh().catch((error) => notice(error.message, true));
}, 2000);
