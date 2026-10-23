# Markdown comments Copilot App Canvas Extension

Use Microsoft Word-style document comments to give Copilot context-specific prompts for Markdown documents within the GitHub Copilot app. Select a passage, add a comment, and let Copilot update the file in your current conversation.

![Selected Markdown text linked to a comment asking Copilot to rewrite the section](docs/images/readme-comment.png)

## How to use

1. Ask Copilot: "Open \<document name> in the Markdown comments canvas," replacing the \<document name> with your document's name.
2. Select text and choose **New comment**, or press **Ctrl+Alt+M** (**Cmd+Option+M** on Mac).
3. Write your feedback prompt, then choose **Post comment** (or select one of the customizable one-click prompts).
4. Review the updated document after Copilot makes the changes. Copilot receives the passage, source location, and feedback; the comment stays open until Copilot verifies the edit and resolves it.

Use **Comment on diagram** for Mermaid feedback and **Show resolved / history** to revisit previous comments. Customize one-click prompts in `feedback.json`.

**Keep in mind:** This is an experimental editor, not a fully lossless Markdown editor. Wait for **Saved** before closing; unsaved drafts have no crash recovery. Conflicting external edits require manual resolution.

Comments are stored locally under the extension's `artifacts\` directory. Posting feedback sends the selected text and source context to Copilot and its configured model provider, using the conversation's normal permissions. External images are not loaded.

## Install

Requires a GitHub Copilot app that supports extension canvases. Canvas APIs are experimental.

Ask Copilot:

> Install the Markdown comments canvas from https://github.com/brooke-hamilton/markdown-comments in my user extensions directory, including any required dependencies and built assets, then reload extensions.

Try `examples\welcome.md` for a sample document.

## License

[MIT](LICENSE)
