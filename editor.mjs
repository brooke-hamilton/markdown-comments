import { Editor, rootCtx, defaultValueCtx, editorViewCtx, parserCtx, serializerCtx, schemaCtx, editorViewOptionsCtx, remarkCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { $node, $prose } from "@milkdown/kit/utils";
import { EditorState, Plugin, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import "@milkdown/kit/prose/view/style/prosemirror.css";
import "@milkdown/kit/prose/tables/style/tables.css";

const rawSource = $node("raw_source", () => ({
    group: "block", content: "text*", marks: "", code: true, defining: true,
    toDOM: () => ["pre", { class: "raw-source", "data-language": "preserved-markdown", "aria-label": "Preserved Markdown source" }, ["code", 0]],
    parseDOM: [{ tag: "pre.raw-source", preserveWhitespace: "full" }],
    parseMarkdown: { match: () => false, runner: () => {} },
    toMarkdown: { match: (node) => node.type.name === "raw_source", runner: (state, node) => state.addNode("html", undefined, node.textContent) },
}));

function domRange(view, from, to) {
    const start = view.domAtPos(from), end = view.domAtPos(to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
}

function rangeText(range) {
    const content = range.cloneContents();
    for (const widget of content.querySelectorAll(".editor-diagram")) widget.remove();
    return content.textContent;
}

export async function createMarkdownEditor({ root, source, editing, onChange, onError, renderDiagram, onDiagram }) {
    let ready = false, instance, view, initialDoc;
    let readonly = false;
    let records = [];
    let baseRecords = [];
    let baseSource = source;
    let tail = editing.tail;
    const anchors = new Map();
    const diagramDecorations = new WeakMap();
    const diagramIds = new WeakMap();
    let nextDiagramId = 0;
    let newline = source.includes("\r\n") ? "\r\n" : "\n";
    const tracking = $prose(() => new Plugin({
        state: {
            init: () => null,
            apply(transaction) {
                if (!ready || !transaction.docChanged) return null;
                for (const record of records) {
                    const mapped = transaction.mapping.mapResult(record.pos, 1);
                    record.pos = mapped.deleted ? -1 : mapped.pos;
                }
                if (transaction.doc.eq(initialDoc)) records = baseRecords.map((record) => ({ ...record }));
                for (const [id, anchor] of anchors) {
                    if (!anchor) continue;
                    const from = transaction.mapping.mapResult(anchor.from, 1);
                    const to = transaction.mapping.mapResult(anchor.to, -1);
                    anchors.set(id, from.deletedAcross || to.deletedAcross || from.pos >= to.pos ? null : { from: from.pos, to: to.pos });
                }
                return null;
            },
        },
        props: {
            decorations(state) {
                if (diagramDecorations.has(state.doc)) return diagramDecorations.get(state.doc);
                const decorations = [];
                const occurrences = new Map();
                state.doc.descendants((node, pos) => {
                    if (node.type.name !== "code_block" || node.attrs.language !== "mermaid") return;
                    if (!diagramIds.has(node)) diagramIds.set(node, nextDiagramId++);
                    const id = diagramIds.get(node);
                    const occurrence = occurrences.get(id) ?? 0;
                    occurrences.set(id, occurrence + 1);
                    const key = `${id}:${occurrence}`;
                    decorations.push(Decoration.widget(pos, () => {
                        const widget = document.createElement("div");
                        widget.className = "editor-diagram";
                        widget.dataset.position = String(pos);
                        widget.dataset.diagramKey = key;
                        widget.contentEditable = "false";
                        const preview = document.createElement("div");
                        preview.className = "mermaid";
                        const button = document.createElement("button");
                        button.type = "button";
                        button.textContent = "Comment on diagram";
                        button.addEventListener("click", () => onDiagram(Number(widget.dataset.position)));
                        widget.append(preview, button);
                        void renderDiagram(preview, node.textContent).catch(onError);
                        return widget;
                    }, { side: -1, key }));
                });
                const result = DecorationSet.create(state.doc, decorations);
                diagramDecorations.set(state.doc, result);
                return result;
            },
        },
        view: (current) => {
            const update = (current, previous) => {
                const positions = new Map(diagramDecorations.get(current.state.doc)?.find().map((decoration) => [decoration.spec.key, decoration.from]));
                for (const widget of root.querySelectorAll(".editor-diagram")) {
                    widget.dataset.position = String(positions.get(widget.dataset.diagramKey));
                }
                if (ready && previous && !current.state.doc.eq(previous.doc)) onChange();
            };
            update(current);
            return { update };
        },
    }));
    try {
        instance = await Editor.make().config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, "");
            ctx.update(editorViewOptionsCtx, (options) => ({
                ...options,
                attributes: { "aria-label": "Editable Markdown", role: "textbox", "aria-multiline": "true", spellcheck: "true" },
                editable: () => !root.dataset.readonly,
                handleDOMEvents: {
                    click: (_view, event) => { if (event.target.closest("a")) event.preventDefault(); return false; },
                    auxclick: (_view, event) => { if (event.target.closest("a")) event.preventDefault(); return false; },
                    drop: (_view, event) => { event.preventDefault(); onError(new Error("File and HTML drops are disabled in this prototype. Paste plain text instead.")); return true; },
                },
                handlePaste: (current, event) => {
                    const text = event.clipboardData?.getData("text/plain");
                    event.preventDefault();
                    if (!text) {
                        onError(new Error("Only plain-text paste is supported. Images and HTML are not imported."));
                        return true;
                    }
                    current.dispatch(current.state.tr.insertText(text));
                    return true;
                },
            }));
        }).use(commonmark).use(gfm).use(history).use(rawSource).use(tracking).create();
        view = instance.action((ctx) => ctx.get(editorViewCtx));
        load(source, editing);
        ready = true;
    } catch (error) {
        if (instance) await instance.destroy();
        throw error;
    }

    function load(source, editing) {
        const focused = view.hasFocus();
        const selection = window.getSelection();
        const domSelection = focused && selection?.rangeCount && view.dom.contains(selection.anchorNode) && view.dom.contains(selection.focusNode) ?
            { anchor: view.posAtDOM(selection.anchorNode, selection.anchorOffset), head: view.posAtDOM(selection.focusNode, selection.focusOffset) } : undefined;
        const nextRecords = [];
        instance.action((ctx) => {
            const schema = ctx.get(schemaCtx), parse = ctx.get(parserCtx);
            const children = [];
            let pos = 0;
            for (const block of editing.blocks) {
                const parsed = block.raw ? undefined : parse(block.source);
                let node = parsed?.childCount === 1 ? parsed.firstChild :
                    schema.nodes.raw_source.create(null, block.source ? schema.text(block.source) : null);
                const previous = records.find((record) => record.source === block.source && record.pos >= 0);
                const existing = previous && view.state.doc.nodeAt(previous.pos);
                // Milkdown assigns heading IDs after parsing. Retain those derived attributes for unchanged content.
                if (existing?.type === node.type && existing.content.eq(node.content) &&
                    Object.keys(node.attrs).every((key) => node.type.name === "heading" && key === "id" || node.attrs[key] === existing.attrs[key])) node = existing;
                children.push(node);
                nextRecords.push({ ...block, node, pos });
                pos += node.nodeSize;
            }
            const doc = schema.nodes.doc.createAndFill(null, children);
            // Map the caret through only the changed region; external updates start a new undo history.
            const start = view.state.doc.content.findDiffStart(doc.content);
            if (start !== null) {
                const end = view.state.doc.content.findDiffEnd(doc.content);
                const overlap = start - Math.min(end.a, end.b);
                const transaction = view.state.tr;
                if (domSelection) transaction.setSelection(TextSelection.create(view.state.doc, domSelection.anchor, domSelection.head));
                transaction.replace(start, end.a + Math.max(0, overlap), doc.slice(start, end.b + Math.max(0, overlap)));
                view.updateState(EditorState.create({ schema, doc: transaction.doc, selection: transaction.selection, plugins: view.state.plugins }));
            } else {
                view.updateState(EditorState.create({ schema, doc: view.state.doc, selection: view.state.selection, plugins: view.state.plugins }));
            }
        });
        records = nextRecords;
        baseSource = source;
        tail = editing.tail;
        newline = source.includes("\r\n") ? "\r\n" : "\n";
        anchors.clear();
        initialDoc = view.state.doc;
        baseRecords = records.map((record) => ({ ...record }));
        if (focused) view.focus();
    }

    function snapshot() {
        if (view.state.doc.eq(initialDoc)) return { source: baseSource, blocks: baseRecords, doc: view.state.doc };
        const byPosition = new Map(), byNode = new Map();
        for (const record of records) {
            if (!byPosition.has(record.pos)) byPosition.set(record.pos, []);
            byPosition.get(record.pos).push(record);
            if (!byNode.has(record.node)) byNode.set(record.node, record);
        }
        const blocks = [];
        let result = "";
        let previousRecord;
        instance.action((ctx) => {
            const serialize = ctx.get(serializerCtx);
            view.state.doc.forEach((node, pos) => {
                const positioned = byPosition.get(pos);
                const record = positioned?.find((entry) => entry.node.eq(node)) ?? byNode.get(node) ?? positioned?.[0];
                const text = record?.node.eq(node) ? record.source : node.type.name === "raw_source" ? node.textContent :
                    serialize(view.state.schema.nodes.doc.create(null, [node])).replace(/\n+$/, "").replace(/\n/g, newline) + newline;
                let prefix = record?.prefix ?? "";
                const adjacent = record && previousRecord && previousRecord.to === record.from - record.prefix.length;
                if (result && !adjacent) {
                    while (!(result + prefix).endsWith(`${newline}${newline}`)) prefix += newline;
                }
                result += prefix;
                const from = result.length;
                result += text;
                blocks.push({ from, to: result.length, pos, node, prefix, source: text });
                previousRecord = record;
            });
        });
        return { source: result + tail, blocks, doc: view.state.doc };
    }

    function positions(range) {
        return { from: view.posAtDOM(range.startContainer, range.startOffset), to: view.posAtDOM(range.endContainer, range.endOffset) };
    }

    function blockFor(pos, blocks) {
        return blocks.find((block) => pos >= block.pos && pos <= block.pos + block.node.nodeSize - 1);
    }

    function diagrams(current) {
        const result = [];
        instance.action((ctx) => {
            for (const block of current.blocks) {
                const nodes = [];
                const collect = (node, pos) => {
                    if (node.type.name === "code_block" && node.attrs.language === "mermaid") nodes.push({ node, pos });
                };
                collect(block.node, block.pos);
                block.node.descendants((node, pos) => collect(node, block.pos + 1 + pos));
                if (!nodes.length) continue;
                const fences = [];
                const visit = (node) => {
                    if (node.type === "code" && node.lang === "mermaid") fences.push(node);
                    for (const child of node.children ?? []) visit(child);
                };
                visit(ctx.get(remarkCtx).parse(block.source));
                for (let index = 0; index < nodes.length; index++) {
                    const fence = fences[index];
                    if (!fence) continue;
                    const start = fence.position.start.offset, end = fence.position.end.offset;
                    const from = block.source.lastIndexOf("\n", start - 1) + 1;
                    result.push({ ...nodes[index], from: block.from + from, source: block.source.slice(from, end) });
                }
            }
        });
        return result;
    }

    return {
        get dirty() { return snapshot().source !== baseSource; },
        snapshot,
        replace(source, editing) {
            ready = false;
            try { load(source, editing); }
            finally { ready = true; }
        },
        setReadonly(value) {
            if (readonly === value) return;
            readonly = value;
            if (value) root.dataset.readonly = "true";
            else delete root.dataset.readonly;
            view.setProps({ editable: () => !value });
        },
        track(id, range) { anchors.set(id, range ? positions(range) : null); },
        range(id) {
            const anchor = anchors.get(id);
            return anchor ? domRange(view, anchor.from, anchor.to) : undefined;
        },
        hasAnchor(id) { return anchors.has(id); },
        diagramElement(id) {
            const anchor = anchors.get(id);
            return anchor ? root.querySelector(`.editor-diagram[data-position="${anchor.from}"]`) : undefined;
        },
        trackText(comment, revision) {
            const current = snapshot();
            const excerpt = comment.sourceExcerpt;
            if (!excerpt) return anchors.set(comment.id, null);
            let offset = current.source.indexOf(excerpt);
            if (comment.revision === revision) {
                offset = current.source.split("\n").slice(0, comment.startLine).join("\n").length + (comment.startLine ? 1 : 0);
                if (current.source.slice(offset, offset + excerpt.length) !== excerpt) return anchors.set(comment.id, null);
            } else if (offset < 0 || current.source.indexOf(excerpt, offset + 1) !== -1) return anchors.set(comment.id, null);
            const blocks = current.blocks.filter((block) => block.from < offset + excerpt.length && block.to > offset);
            if (!blocks.length) return anchors.set(comment.id, null);
            const first = blocks[0], last = blocks.at(-1);
            const nodes = [];
            const walker = document.createTreeWalker(view.dom, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const node = walker.currentNode;
                if (node.parentElement.closest(".editor-diagram")) continue;
                const pos = view.posAtDOM(node, 0);
                if (pos > first.pos && pos < last.pos + last.node.nodeSize - 1) nodes.push(node);
            }
            const text = nodes.map((node) => node.textContent).join("");
            const matches = [];
            for (let index = text.indexOf(comment.quote); index !== -1; index = text.indexOf(comment.quote, index + 1)) {
                if (text.slice(0, index).endsWith(comment.anchor?.prefix ?? "") &&
                    text.slice(index + comment.quote.length).startsWith(comment.anchor?.suffix ?? "")) matches.push(index);
            }
            if (matches.length !== 1) return anchors.set(comment.id, null);
            const from = matches[0], to = from + comment.quote.length;
            let length = 0, start, end;
            for (const node of nodes) {
                if (start === undefined && from >= length && from < length + node.textContent.length) start = view.posAtDOM(node, from - length);
                if (to > length && to <= length + node.textContent.length) end = view.posAtDOM(node, to - length);
                length += node.textContent.length;
            }
            anchors.set(comment.id, start !== undefined && end !== undefined ? { from: start, to: end } : null);
        },
        trackDiagram(comment, revision) {
            const current = snapshot();
            const matches = diagrams(current).filter((record) => record.source === comment.quote.replace(/\r$/, ""));
            const match = matches.length === 1 ? matches[0] : comment.revision === revision ?
                matches.find((record) => current.source.slice(0, record.from).split("\n").length - 1 === comment.startLine) : undefined;
            anchors.set(comment.id, match ? { from: match.pos, to: match.pos + match.node.nodeSize } : null);
        },
        selection(range) {
            const anchor = positions(range);
            anchors.set("draft", anchor);
            return anchor;
        },
        selected() {
            const anchor = anchors.get("draft");
            if (!anchor) throw new Error("The selected passage was removed. Cancel and select a current passage.");
            const current = snapshot(), lines = current.source.split("\n");
            const first = blockFor(anchor.from, current.blocks), last = blockFor(Math.max(anchor.from, anchor.to - 1), current.blocks);
            if (!first || !last) throw new Error("Cannot map this selection to Markdown. Select a current passage again.");
            const startLine = current.source.slice(0, first.from).split("\n").length - 1;
            const endLine = Math.min(lines.length, current.source.slice(0, last.to).replace(/\r?\n$/, "").split("\n").length);
            const range = domRange(view, anchor.from, anchor.to);
            const quote = rangeText(range);
            const before = rangeText(domRange(view, Math.min(first.pos + 1, anchor.from), anchor.from));
            const after = rangeText(domRange(view, anchor.to, Math.max(anchor.to, last.pos + last.node.nodeSize - 1)));
            const endBlockOffset = rangeText(domRange(view, Math.min(last.pos + 1, anchor.to), anchor.to)).length;
            const documentBefore = document.createRange();
            documentBefore.selectNodeContents(root);
            documentBefore.setEnd(range.startContainer, range.startOffset);
            const startOffset = rangeText(documentBefore).length;
            return {
                kind: "text", quote, startLine, endLine, startOffset, endOffset: startOffset + quote.length,
                anchor: { prefix: before.slice(-160), suffix: after.slice(0, 160), startBlockOffset: before.length, endBlockOffset },
            };
        },
        diagram(pos) {
            const current = snapshot(), block = diagrams(current).find((block) => block.pos === pos);
            if (!block) throw new Error("The diagram changed. Select it again.");
            const startLine = current.source.slice(0, block.from).split("\n").length - 1;
            const quote = block.source;
            anchors.set("draft", { from: pos, to: pos + block.node.nodeSize });
            return { kind: "diagram", quote, startLine, endLine: startLine + quote.split("\n").length, startOffset: 0, endOffset: quote.length };
        },
        diagramFor(id) {
            const anchor = anchors.get(id);
            if (!anchor) throw new Error("The diagram was removed. Select a current diagram.");
            return this.diagram(anchor.from);
        },
        focus() { view.focus(); },
        accept(saved, checkpoint = snapshot()) {
            if (view.state.doc.eq(checkpoint.doc)) records = checkpoint.blocks.map((record) => ({ ...record }));
            baseRecords = checkpoint.blocks.map((record) => ({ ...record }));
            baseSource = saved.source;
            initialDoc = checkpoint.doc;
        },
        destroy: async () => {
            await instance.destroy();
            delete root.dataset.readonly;
        },
    };
}
