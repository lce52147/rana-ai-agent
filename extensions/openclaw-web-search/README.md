# @ollama/openclaw-web-search

Web search plugin for OpenClaw using Ollama's web search API.

## Package Structure

- `index.ts`: Plugin implementation and tool registration
- `openclaw.plugin.json`: Plugin metadata manifest
- `package.json`: npm package metadata

## Authentication Setup

The easiest setup inside OpenClaw chat is:

```text
/websearch auth YOUR_OLLAMA_API_KEY
```

Use a private or owner-only chat for that command. Some channels may keep slash-command text in history or provider logs.
That command now saves the key and enables `ollama_web_search` in OpenClaw tool policy.

You can also paste an Ollama API key into the plugin config directly:

```bash
openclaw config set plugins.entries.openclaw-web-search.config.apiKey YOUR_OLLAMA_API_KEY
```

Create a key at [ollama.com/settings/keys](https://ollama.com/settings/keys).

The plugin also provides:

```text
/websearch status
/websearch enable
/websearch auth clear
```

On Linux, this is the recommended path because `~/.ollama/id_ed25519` is often owned by the `ollama` service user instead of the user running OpenClaw.

The `/websearch auth` command updates the live plugin immediately, persists the key to OpenClaw config, and enables the web search tool in global tool policy. If you edit config outside the running process, start a new session or restart the OpenClaw gateway so the extension reloads with the new config.

You can also use an environment variable instead:

```bash
export OLLAMA_API_KEY="YOUR_OLLAMA_API_KEY"
```

If no API key is configured, the plugin falls back to file-based auth with `~/.ollama/id_ed25519` and, on WSL, the Windows-side Ollama key if it is available.

## Testing

```bash
npx tsx -e "
import plugin from './index.ts';

let tool;
plugin.register({
  registerTool(t) { tool = t; }
});

tool.execute('test', { query: 'hello world' }).then(r => {
  console.log(JSON.stringify(r, null, 2));
}).catch(e => {
  console.error('Error:', e.message);
});
"
```

## Notes

- This package currently publishes TypeScript source directly.
- The OpenClaw extension entry is configured via the `openclaw.extensions` field in `package.json`.
