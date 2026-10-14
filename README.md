# Markdown comments

A canvas extension for the GitHub Copilot app that puts document feedback next
to the passage it refers to. Select rendered Markdown, add a Word-style review
comment, and send a contextual edit request to the **current Copilot conversation**.

## Features

- Rendered Markdown: headings, tables, links, lists, code, and Mermaid diagrams.
- Selection-based custom feedback and configurable one-click feedback:
  **Fix this slop**, **Provide more context**, and **Rewrite**.
- A comment sidebar, text-range highlights, and resolve/reopen controls.
  Click a comment to scroll to its original passage in the same revision.
- Per-document comments that survive canvas reloads and extension restarts.
- Automatic preview updates after file changes, with stale-selection protection.
- Local, bundled rendering: no CDN calls or remote image fetching.

This first version is a **review canvas, not a direct text editor**. The canvas
API provides an isolated iframe, not an extensible copy of the app's built-in
Markdown editor. Copilot edits the original file through its normal tools,
permissions, and conversation mode.

## Install at user scope

Requires Node.js 22+ with npm, and a Copilot app/runtime supporting extension
canvases. Canvas APIs are experimental.

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

1. Select a passage in the rendered document.
2. Choose a standard feedback button, or type custom feedback and send it.
3. Copilot receives the file path, selected rendered quote, source block's line
   range and Markdown, file revision, and feedback. You do not need to identify
   the section again in chat.
4. Review the resulting file changes. Resolve the comment when satisfied.

Use **Comment on diagram** to target the complete Mermaid source block. SVG
label selections are deliberately not treated as editable source ranges.
Feedback across formatted text or multiple paragraphs retains the rendered
quote and enclosing source blocks rather than pretending rendered character
offsets are raw Markdown offsets.

**Sent** means the runtime accepted the message, not that an edit succeeded.
Feedback is queued in the current conversation so it does not interrupt an
in-progress turn. Plan mode and permission prompts still apply. Failed delivery
is displayed and saved; unconfirmed delivery after a crash is shown as pending.
There is no automatic retry that could accidentally submit a request twice.

The preview polls disk every two seconds while visible. Auto-refresh pauses
while a passage is selected so typing a comment does not lose its context.
If the file changed, sending is rejected; use **Refresh** and select it again.
Comments on earlier revisions keep their original quote and are labeled as
outdated rather than silently reanchored to possibly different text.

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

Source files remain where they are; the extension does not directly write them.
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

```powershell
npm ci
npm run build
npm test
npx playwright install chromium
npm run test:browser
```

`npm run check` builds and runs both test suites. Browser tests use a local
test document and a mock message sender; they do not call a model.
After changing extension code or rebuilding assets, reload extensions in Copilot.

`extension.mjs` owns SDK registration and per-panel cleanup; `review.mjs` owns
source mapping, durable comments, configuration, and contextual requests;
`server.mjs` serves the loopback API; `ui.mjs` renders the selection/comment UI.
Agent actions `refresh` and `list_comments` expose the open document's state.

## License

[MIT](LICENSE). The GitHub repository is initially private.
