---
name: seo-content-writing
description: Write web pages, blog posts and product descriptions that match what people search for — search intent, outline, title and meta description, headings, internal links — without keyword stuffing or invented claims. Use when a task asks for website copy, a blog article, product texts or SEO improvements to existing pages.
key: paperclipai/optional/content/seo-content-writing
recommendedForRoles:
  - writer
  - marketing
  - content
  - seo
tags:
  - seo
  - copywriting
  - blog
  - product-descriptions
  - content
---

# SEO Content Writing

Write pages that answer what the searcher actually wants, in clear language, so both people and search engines understand them. Helpful and accurate beats clever and keyword-heavy.

## When to use

- A task asks for a blog post, landing page, category page, FAQ or product descriptions.
- Someone asks to "improve SEO" for an existing page or to write titles and meta descriptions.
- A batch of products needs consistent descriptions.

## When not to use

- Short social posts. Use `paperclipai/optional/content/social-media-management`.
- Technical SEO work (site speed, crawling, structured data code, redirects). That is a developer task; write it up as a task for them.
- You cannot see the product or topic facts. Ask for them; do not fill gaps with guesses.

## Hard rules

- **No invented facts.** Every spec, size, material, price, result, statistic or claim comes from the brief, the product data or a source you opened (with its link). If something is missing, write `[confirm: …]` instead of guessing.
- **No unprovable claims.** Avoid "best", "#1", "cheapest", health or environmental claims, and comparisons with competitors unless the brief gives proof. These can be illegal in some markets.
- **No keyword stuffing.** Use the main phrase naturally in the title, first paragraph, one heading and the meta description — then write for humans. Never hide text or repeat lists of keywords.
- **No copying.** Do not copy text from competitors or manufacturer pages word for word; rewrite in the company's voice and add real value.
- **Write in the market's language** (the language of the page's audience), with local spelling, units and currency.
- **Publishing needs approval.** Deliver drafts; a person approves before anything goes live (see the `paperclip` skill).

## Procedure

1. **Understand the goal and audience:** who searches, what they want to achieve, and what the page should make them do (buy, contact, sign up, learn).
2. **Pick the main search phrase and intent.** Intent is one of: *informational* (learn), *commercial* (compare), *transactional* (buy), *navigational* (find a brand/page). Write a page type that matches: a guide for informational, a comparison for commercial, a product/category page for transactional.
3. **List 3–8 related phrases and questions** people ask about the topic (from the brief, the site's search data, or a search you ran). Use them as section ideas, not as words to repeat.
4. **Outline:** one H1, logical H2/H3 sections, each answering one question. Put the direct answer early.
5. **Write the draft:**
   - Short paragraphs (2–4 sentences), plain words, active voice.
   - Lists and tables where they help comparison.
   - 2–5 internal links to relevant pages on the same site, with descriptive link text (never "click here").
   - A clear call to action.
6. **Write the title and meta description:**
   - Title: about 50–60 characters, main phrase near the start, brand at the end if room.
   - Meta description: about 140–155 characters, a reason to click, no quotes or emoji spam.
   - URL slug: short, lowercase, hyphens, main phrase.
7. **Product descriptions:** start with who it is for and the main benefit; then key facts as a short list (size, material, care, compatibility); then any details. Same structure across a batch.
8. **Self-check:** facts sourced, no forbidden claims, reads well out loud, every image has alt text.
9. **Hand over** the draft as a document on the task, with open `[confirm: …]` items listed at the top.

## Output template

```md
**Main phrase:** <phrase> · **Intent:** <type> · **Audience:** <who>
**Open items to confirm:** <list or "none">

**Title (<n> chars):** <title>
**Meta description (<n> chars):** <description>
**Slug:** /<slug>

# <H1>
<intro with the direct answer>

## <H2>
<section>

**Internal links used:** <anchor text> → <page>
**Image alt texts:** <image>: <alt text>
**Sources:** <links for facts used>
```

## Done when

- [ ] The page type matches the search intent.
- [ ] Title and meta description are within length and contain the main phrase naturally.
- [ ] Every fact is sourced or marked `[confirm: …]`.
- [ ] No keyword stuffing, copied text or unprovable claims.
- [ ] Draft is delivered for approval, not published.
