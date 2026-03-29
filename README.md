# CWrite

A low-friction, browser-based creative writing IDE designed specifically for collaborative interaction with large language models in a deeply refined, distraction-free environment.

## Features

- **Robust Editor:** A responsive and adaptive writing environment that maximizes screen space in landscape mode.
- **Intelligent Undo/Retry:** Advanced segment-based rollback logic lets you discard and retry only the *latest chunk* of a generation seamlessly without wiping entire message blocks.
- **Real-Time Slop Detection:** Monitors output generated from an LLM during streaming, highlighting repetitive n-grams automatically and offering customizable Auto-Stop/Rollback triggers.
- **Focus & Zen Mode (`F11`):** Clears toolbars, sidebars, and fades out status elements for pure distraction-free immersion.
- **Find & Replace (`Ctrl+F`):** A custom built `TreeWalker` integration safely highlights text matches dynamically across Markdown-parsed messages without corrupting formatting flags or raw HTML.
- **Author's Note:** Tweak and inject precise, hidden steering directives seamlessly positioned `n` messages before the context threshold.
- **Portability:** Auto-saves securely to IndexedDB with additional built-in Session Export/Import options as `.json` backups.

## Tech Stack

CWrite operates with minimal bloat.
- **Vite:** Blazing-fast frontend tooling
- **Vanilla JS + CSS:** Zero-dependency UI built meticulously for top-tier performance
- **Dexie:** Elegant, wrapped IndexedDB for fast client-side storage
- **Marked.js:** Secure parsing of generated Markdown directly into the chat interface

## Getting Started

1. **Clone the repository:**
   ```bash
   git clone https://github.com/LuckyKo/CWrite.git
   cd CWrite
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Run the local development server:**
   ```bash
   npm run cwrite
   ```

4. **Connect an LLM:**
   CWrite utilizes OpenAI-compatible REST endpoints. By default, it looks for API services on `http://localhost:5001/v1` (highly optimized for [KoboldCpp](https://github.com/LostRuins/koboldcpp) or local server equivalents), but you can customize the API Key, Settings, and Model details through the **Settings Panel**.

## Key Bindings
| Shortcut | Action |
| --- | --- |
| `Ctrl+Enter` | Send/Generate Response |
| `Ctrl+Shift+Enter` | Continue current assistant message |
| `Escape` | Stop Generation / Close Find Bar |
| `Ctrl+Shift+N` | Add new User Message block |
| `Ctrl+/` | Toggle Raw Edit Mode |
| `Ctrl+F` | Open Find & Replace Bar |
| `F11` | Toggle Zen Mode |
