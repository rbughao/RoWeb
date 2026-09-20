# Tootsy — Privacy Policy

_Last updated: 2026-09-20_

Tootsy is a Chrome extension that connects your browser to an LLM endpoint **you choose** (a local Ollama/LM Studio server, an OpenAI-compatible server, the Anthropic API or Google Gemini). The developer of Tootsy runs no servers and receives no data from the extension.

## What Tootsy processes

- **Page content** — when you ask about a page or give a browsing task, Tootsy reads text, links, form fields and (if you ask for a screenshot) an image of the current tab, and sends what is needed to *your configured endpoint* as part of the conversation.
- **Your prompts, files and images** — text you type, files and images you add to the panel, and the text of PDFs you open are stored locally (IndexedDB / `chrome.storage`) and sent to your endpoint when relevant.
- **Settings** — endpoint URL, API key, model choices, custom instructions, site lists, notes, saved tasks, chat history and the action log are stored locally in your browser profile only.

## Where data goes

- Only to the endpoint URL you entered in settings. If that is a hosted provider (OpenAI-compatible, Anthropic, Gemini), that provider's privacy policy applies to what you send.
- Web search uses a normal DuckDuckGo or Bing results page opened in a background tab; those sites see the query like any other visit.
- Nothing is sent to the extension developer. There is no analytics, telemetry, crash reporting or advertising.

## Optional permissions and features

- **History** search is off by default and only enabled when you opt in; results are used to answer your question and are not stored.
- **DevTools-level tools** (console logs, network capture, running JavaScript, PDF export) attach Chrome's debugger only for the duration of a single tool call and only when you turn the toggle on.
- **Scheduled tasks** run in the background with the same endpoint and store their result as a chat locally.
- **Protected sites**: domains you list in settings are never acted on (clicks, typing, navigation, scripts).

## Data retention and deletion

Everything lives in your Chrome profile. Delete chats, notes, tasks, files or the action log from the panel, use **Backup → Export** to take a copy, or remove the extension to delete all of it. Backups you export contain your API keys — treat them as secrets.

## Contact

Open an issue at https://github.com/rbughao/RoBu.
