---
name: jina-md
description: >
  Convert any web page to clean markdown via Jina Reader (https://r.jina.ai/<URL>).
  Use when you need a URL's content as markdown — for reading, summarizing, quoting, or processing.
  Always prefer this over WebFetch when you need structured markdown output from a URL.
---

# jina-md

Convert web pages to clean markdown using Jina's Reader API. No API key or CLI required — just `curl`.

## Usage

```bash
curl -s "https://r.jina.ai/<URL>"
```

Replace `<URL>` with the target page (must include `https://` or `http://`).

## Examples

```bash
# Convert an article to markdown
curl -s "https://r.jina.ai/https://example.com/blog/post"

# Convert documentation
curl -s "https://r.jina.ai/https://docs.python.org/3/library/asyncio.html"

# Save to file
curl -s "https://r.jina.ai/https://example.com" > page.md

# Timeout for slow sites
curl -s --max-time 30 "https://r.jina.ai/https://example.com"

# Preview first N lines
curl -s "https://r.jina.ai/https://example.com" | head -100
```

## Notes

- Works on most public pages. Authenticated or paywalled content returns limited results.
- If the response is empty or errors, the site may be blocking the request — fall back to WebFetch.
- Long pages can be piped through `head` or `rg` to filter.
