---
name: grep-app
description: >
  Code search across millions of public GitHub repositories via grep.app. Use before writing or planning code to find real-world usage of libraries, frameworks, APIs, algorithms, or syntax patterns. Prefer this over web search for code examples.
allowed-tools:
  - Bash(curl:*)
  - Bash(jq:*)
---

# grep.app

Search real-world code examples from over a million public GitHub repositories. Powered by [grep.app](https://grep.app). No API key required.

## searchGitHub

Find real-world code examples by searching for **literal code patterns** (like grep), not keywords.

### API

```
curl -sL 'https://grep.app/api/search?q={query}&format=json' | jq
```

Optional filters — append as query parameters:

| Parameter | Description | Example |
|---|---|---|
| `filter[lang][]` | Language filter (repeatable) | `&filter[lang][]=Python&filter[lang][]=TypeScript` |
| `filter[repo][]` | Repository filter (repeatable) | `&filter[repo][]=facebook/react` |
| `filter[path][]` | File path filter (repeatable) | `&filter[path][]=/route.ts` |
| `regexp` | Interpret query as regex | `&regexp=true` |
| `case` | Case-sensitive search | `&case=true` |

### Basic usage

```bash
curl -sL 'https://grep.app/api/search?q=useState%28&format=json' | jq
curl -sL 'https://grep.app/api/search?q=getServerSession&format=json&filter[lang][]=TypeScript&filter[lang][]=TSX' | jq
curl -sL 'https://grep.app/api/search?q=CORS%28&format=json&case=true&filter[lang][]=Python' | jq
```

### Filter by repo or path

```bash
curl -sL 'https://grep.app/api/search?q=createContext&format=json&filter[repo][]=facebook/react' | jq
curl -sL 'https://grep.app/api/search?q=export+default&format=json&filter[path][]=/route.ts&filter[lang][]=TypeScript' | jq
```

### Regex patterns

```bash
curl -sL 'https://grep.app/api/search?q=%28%3Fs%29useEffect%5C%28%5C%28%29%20%3D%3E%20%5C%7B.*removeEventListener&format=json&regexp=true' | jq
```

## Tips

- Search for **actual code** that appears in files, not keywords or questions
  - Good: `useState(`, `import React from`, `async function`
  - Bad: `react tutorial`, `best practices`, `how to use`
- URL-encode special characters in the query (`(` → `%28`, `)` → `%29`, space → `+` or `%20`)
- Use `(?s)` prefix in regex to match across multiple lines
- Filter by `filter[lang][]` to narrow results to relevant file types
- Filter by `filter[repo][]` with org prefix (e.g. `vercel/`) to search within an organization
