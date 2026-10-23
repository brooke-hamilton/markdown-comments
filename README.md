# Markdown comments

A canvas extension for the GitHub Copilot app that puts document feedback next
to the passage it refers to. Select rendered Markdown, add a Word-style review
comment, and send a contextual edit request to the **current Copilot conversation**.

## Features

- Rendered Markdown: headings, tables, links, lists, code, and Mermaid diagrams.
- Selection-based custom feedback and configurable one-click feedback:
  **Fix this slop**, **Provide more context**, and **Rewrite**.
- Word-style margin balloons beside the passage or diagram, with connector
  lines, linked text highlights, and collision avoidance.
- A floating **New comment** control at the selection, plus **Ctrl+Alt+M**
  (or **Cmd+Option+M**) to open a focused comment box beside that passage.
- Posted comments stay visible until Copilot explicitly resolves them after
  editing. Resolved comments are hidden, not deleted, and can be reopened.
- Per-document comments that survive canvas reloads and extension restarts.
- Automatic preview updates after file changes, with stale-selection protection.
- Local, bundled rendering: no CDN calls or remote image fetching.

The canvas is an editable Milkdown/ProseMirror prototype: edit rendered Markdown and add margin comments in the same view, without switching modes. This uses our own editor inside the extension's isolated iframe, not the app's built-in editor.

## Editable Markdown prototype

Edit headings, paragraphs, formatting, lists, tables, and code directly. Markdown input rules and undo/redo are available. Changes save automatically after 600 ms of idle time, with a save scheduled at least every two seconds during continuous editing. Saves are serialized, and typing can continue while a save is in flight. The header shows **Saving...**, **Saved**, or an explicit error; there are no normal Save, Refresh, or mode-switch buttons. **Ctrl+S / Cmd+S** can also flush pending changes without sending anything to Copilot.

Select text in the editor and use **New comment** or **Ctrl+Alt+M / Cmd+Option+M** as usual. The editor pauses while the comment composer is open. Posting feedback first saves the draft and then sends the selection with its saved source range and revision. Failed saves send no feedback and leave both the document draft and comment composer intact. A successful save followed by failed feedback delivery leaves the document saved and reports the delivery error separately.

Existing comment ranges move through local ProseMirror transactions. Deleting a target unlinks its comment rather than attaching it to another occurrence. Original quotes and review history are preserved; manually editing a target does not resolve its comment. After an external update or reopening the document, changed targets can remain unlinked and require explicit reselection. The prototype does not persist live editor positions or draft undo history.

Mermaid fences show a rendered preview above their editable code. Change the code to update the diagram, or choose **Comment on diagram** to comment on the complete fence. Malformed diagrams show an error without preventing source editing.

Unchanged top-level source blocks and their surrounding whitespace are retained verbatim, including CRLF line endings. Changed rich-text blocks are serialized by Milkdown and can normalize Markdown syntax inside those blocks. YAML front matter, HTML, images, reference-style links/definitions, code fences with additional metadata, and detected custom directives or math blocks use labeled, editable **Preserved Markdown source** blocks instead of being converted into rich text. Other unfamiliar syntax may appear as literal text; this is not a general lossless Markdown editor. Paste accepts plain text only; file/HTML drops and image uploads are not supported. Remote images remain blocked.

The canvas checks disk every two seconds while visible. Clean external changes update the existing editor automatically, preserving the caret or selection where possible and starting a new undo history so undo cannot overwrite an external revision. These updates do not trigger echo saves. If there are unsaved local edits or an open comment composer, the canvas preserves them and shows a conflict instead. **Use disk version** appears only for conflicts and asks for confirmation before discarding a local draft or comment; copy any edits or feedback you want to keep first. Canceling a comment allows a deferred clean update to load automatically. There is no automatic merge.

Failed saves remain visibly unsaved and expose **Retry autosave** rather than repeatedly retrying in the background. Saves use a revision check, a shared canvas-save lock, and a temporary file renamed into place; noncooperating external editors are not governed by that lock, so this is not a cross-application atomic compare-and-swap guarantee.

Unsaved drafts exist only in the open panel. The browser is asked to warn before unloading a dirty editor, but the host may close a panel without presenting that warning. Wait for **Saved**, or copy an unsaved draft before closing, reloading extensions, or restarting the app; crash recovery is not implemented. The prototype retains the existing 2 MiB document limit.

## Install at user scope

Requires Node.js 22.12.0+ with npm, and a Copilot app/runtime supporting extension canvases. Canvas APIs are experimental.

Clone the repository into your Copilot user extensions directory:

```powershell
git clone https://github.com/brooke-hamilton/markdown-comments.git "$HOME\.copilot\extensions\markdown-comments"
Set-Location "$HOME\.copilot\extensions\markdown-comments"
npm ci
npm run build
```

If you use a custom `COPILOT_HOME`, substitute that directory for
`$HOME\.copilot`. Do not install `@github/copilot-sdk`; the runtime supplies it.
The package manifest is for renderer dependencies and development tools only.

Ask Copilot to reload extensions, then say:

> Open `C:\absolute\path\to\document.md` in the Markdown comments canvas.

The canvas ID is `markdown-comments`; its open input is
`{ "path": "<absolute Markdown file path>" }`.
`examples\welcome.md` provides a sample document.

## Review workflow

1. Select a passage in the rendered document, then choose **New comment** near
   the selection, or press **Ctrl+Alt+M**.
2. In the comment balloon beside that passage, choose a standard feedback
   button, or type custom feedback and choose **Post comment**.
3. Copilot receives the file path, selected rendered quote, source block's line
   range and Markdown, file revision, and feedback. You do not need to identify
   the section again in chat.
4. The comment stays beside the text while Copilot works. After making and
   verifying the edit, Copilot resolves it and its balloon disappears.
   **Show resolved / history** reveals completed comments and earlier attempts.
   **Reopen** sends the original feedback again when the passage is still
   safely linked and its source block is unchanged and unambiguous.

Reopening creates a new comment and delivery attempt; the original quote,
feedback, and resolution metadata remain in history. The new request includes
the current revision, current source lines, rendered selection, and original
feedback, with the same compact chat summary. Editing or deleting a feedback
preset does not change the instructions of an existing comment.

If the passage changed or is ambiguous, **Reopen** does not send anything.
Choose **Select current passage**, select the intended text (or use **Comment
on diagram**), and choose **New comment**. The composer retains the original
feedback; **Resubmit feedback** confirms the new target. **Cancel** sends nothing.
Older saved comments without a source snapshot also require this explicit
selection after the document changes. Already-open comments whose passages
became unlinked provide the same action instead of implying Copilot can guess
where to edit.

Chat shows a compact summary with the document name, source line or line range,
and your feedback. For standard feedback buttons it shows the preset label.
The SDK's `displayPrompt` keeps the full instructions and JSON context out of
the visible chat message while still sending them to Copilot. The summary is
not an expandable JSON block, and existing chat messages are unchanged.

Use **Comment on diagram** to open a comment balloon beside that diagram and
target the complete Mermaid source block. SVG
label selections are deliberately not treated as editable source ranges.
Feedback across formatted text or multiple paragraphs retains the rendered
quote and enclosing source blocks rather than pretending rendered character
offsets are raw Markdown offsets.

Click a comment to return to its passage and activate its linked highlight. Clicking document text positions the caret instead of taking over editing. Comments move with their anchors when the document is resized; overlapping balloons stack without covering each other. Narrow views retain the document and comment margin side by side with horizontal scrolling. **Cancel** or **Escape** discards an unposted comment.

**Sent** means the runtime accepted the message, not that an edit succeeded.
Feedback is queued in the current conversation so it does not interrupt an
in-progress turn. Plan mode and permission prompts still apply. Failed delivery
is displayed and saved; unconfirmed delivery after a crash is shown as pending.
There is no automatic retry that could accidentally submit a request twice.
Failed attempts have an explicit **Retry** button. Repeated Reopen requests for
the same original comment reuse its saved attempt rather than sending twice,
including across panels and session providers. Pending/unconfirmed attempts
cannot be retried: check the conversation first. A provider crash during a
comment update can leave an `artifacts\<document-key>\<comment-id>.lock`
directory; updates then fail explicitly instead of risking another send.
Only remove that specific empty lock directory after confirming no provider is
still updating the comment and checking delivery in the conversation.

Disk updates are automatic, including while text is selected; an open comment composer or unsaved document draft defers replacement to protect local work. Sending checks the saved revision and rejects stale feedback. Comments on earlier revisions keep their original quote and are labeled as outdated if their text changed or is ambiguous. An unchanged quote can reattach when its source and surrounding context identify exactly one passage. An unlinked comment stays visible near its previous position with an explicit retarget action; the canvas does not infer completion from file changes or model inactivity.

The agent tool `markdown_comments_resolve_comment` takes `path` and `commentId`
from the feedback request. Copilot is instructed to call it only after making
and verifying the requested edit, and to leave blocked or failed work open.
The tool rejects resolution if delivery failed or the document has not changed.

## Configure feedback

Edit `feedback.json` in the extension checkout:

```json
{
  "prompts": [
    {
      "id": "rewrite",
      "label": "Rewrite",
      "prompt": "Rewrite for clarity and concision while preserving meaning."
    }
  ]
}
```

IDs must be unique. Labels and instructions must be nonempty. Up to 50 prompts
are supported; an empty array leaves custom feedback available. Configuration
is read from disk on refresh and before submission; invalid configuration is
reported, not silently replaced with defaults. Custom feedback is limited to
8,000 characters, selections to 16,000, and documents to 2 MiB.

## Data and trust boundaries

Source files remain where they are. The canvas autosaves manual edits only to the opened Markdown file and flushes pending changes before posting feedback. These are local editor saves, not agent file-tool edits; Copilot's subsequent edits still use its normal tools, permissions, and conversation mode.
Comments are stored as individual JSON files under `artifacts\` in the user extension directory,
keyed by the canonical absolute document path, not a transient panel ID.
These files include selected document text and feedback; they are gitignored.
Do not commit or share them if the document is sensitive. Renaming a document
creates a new review identity. Two panels for the same file share its comments.

Only the document explicitly opened by the agent is exposed by each loopback
server. URLs contain a random capability token; mutation requests require
same-origin JSON. No general file-browser or arbitrary-file HTTP endpoint is
provided. Raw Markdown HTML is escaped, generated markup and SVG are sanitized,
and Mermaid uses strict security mode. Images display their alt text instead of
fetching external resources.

Feedback is sent to Copilot (and its configured model provider), just like a
chat request. Review comments and source excerpts are document data, not
trusted system instructions. This extension does not grant tool permissions.

## Develop

From any source checkout or Copilot worktree, deploy the code currently on disk (including uncommitted changes) into the local Copilot app:

```powershell
npm ci --userconfig "$HOME\.npmrc"
npm --userconfig "$HOME\.npmrc" run deploy:local
```

Run `npm ci` initially or when dependencies need restoring, not before every deployment. Node.js 22.12.0+ is required. The command resolves its source from the script's location, builds the renderer, and runs unit tests before changing the installation. It uses the user-profile root `.npmrc` settings for npm subprocesses.

Dependabot checks the root npm dependencies weekly using `.github/dependabot.yml`, with a seven-day cooldown for new releases.

The configured npm feed does not yet provide Markdown-it 14.3.3. While retaining the feed-supported dependency, `markdown-reference.mjs` backports the upstream reference-parser fix for GHSA-gfr2-rv44-r23c and replaces that rule in every review rendering/source-mapping operation. Raw HTML remains disabled, preventing the separate inline-HTML parsing issue. npm audit still reports the installed package version because it cannot recognize application-level backports; the finding is not suppressed. Remove the backport after upgrading to a patched release available through the feed.

The destination is `$HOME\.copilot\extensions\markdown-comments`, or `$env:COPILOT_HOME\extensions\markdown-comments` when `COPILOT_HOME` is set. A linked or junction-backed Copilot home is resolved to its physical location. The source and destination must not overlap; run this command from a separate checkout/worktree, not from a clone already inside that installation directory. Symlinks and junctions within the resolved extension destination are rejected.

Deployment copies an explicit set of runtime files, the built renderer, and the sample document. It installs locked production dependencies in a staging directory outside extension discovery and validates them before replacing installed files. The result is a snapshot, not a link: it works after the source worktree is removed. Development tools, source-only files, and source-worktree `artifacts\` are not copied. The installed snapshot is for running the extension, not developing or running npm scripts; keep using the source checkout for those tasks. The runtime supplies `@github/copilot-sdk`; deployment does not install it.

Installed saved comments under `artifacts\` (including comment lock directories) and unrelated files are preserved. Installed `feedback.json` is **replaced** with the worktree's version, so one-click feedback buttons match the code being tested. Replacement failures restore the previous managed files. If rollback itself fails, the command reports the retained recovery directory and deployment lock; do not remove these until recovery is complete. Never remove comment locks or saved data to fix a deployment failure.

After successful deployment, ask Copilot to **reload extensions**, inspect the user-scoped `markdown-comments` provider, then open the absolute sample path printed by the command. Copying files alone does not activate the new provider. Reload immediately after deployment; replacing files is not hot reload, and already-running providers may still be using older code. Other open sessions may each need a reload and canvas reopen. The deployment command does not restart the app or terminate processes to bypass Windows file locks.

For agent-driven testing, the personal skill `bh-test-markdown-comments` runs deployment from the identified source worktree, reloads and inspects the provider, and opens the installed sample using a stable canvas panel. This skill is installed separately in the user's `.copilot\skills\` directory; it is not distributed by this repository or the deployment command. Ask Copilot to “deploy this Markdown comments worktree for testing.” Its smoke test does not post feedback, send a model request, or edit the sample. To test feedback delivery, select a passage and post a comment in the intended conversation yourself.

Browser tests remain separate from deployment:

```powershell
npm --userconfig "$HOME\.npmrc" run test:browser
# If Chromium has not been installed:
npx --userconfig "$HOME\.npmrc" playwright install chromium
```

`npm run check` builds and runs both test suites. Browser tests use a local test document and a mock message sender; they do not call a model. Build first when running browser tests separately after renderer changes.

`extension.mjs` owns SDK registration and per-panel cleanup; `review.mjs` owns source mapping, revision-checked document saving, durable comments, configuration, and contextual requests; `server.mjs` serves the loopback API; `ui.mjs` renders the selection/comment UI; `editor.mjs` integrates Milkdown, source-block preservation, and transaction-mapped comment anchors. The renderer bundles both JavaScript and CSS; deployment includes both assets. Agent actions `refresh` and `list_comments` expose the saved document's state, not an unsaved browser draft.

## License

[MIT](LICENSE). The GitHub repository is initially private.
