---
name: social-media-management
description: Plan and write social media posts — content calendar, per-platform formats, brand voice, captions and hashtags — and get every post approved before it is published. Use when a task asks for social posts, a posting plan, a content calendar or a social performance summary.
key: paperclipai/optional/content/social-media-management
recommendedForRoles:
  - social-media-manager
  - marketing
  - content
  - writer
tags:
  - social-media
  - content-calendar
  - instagram
  - linkedin
  - tiktok
  - marketing
---

# Social Media Management

Keep a steady stream of on-brand posts that fit each platform, and make sure a person approves every single post before it goes live.

## When to use

- A task asks for "this week's posts", a content calendar, captions, hashtags or a campaign plan.
- A launch, offer or event needs social posts across several platforms.
- Someone asks how last period's posts performed.

## When not to use

- Long-form articles or product page text. Use `paperclipai/optional/content/seo-content-writing`.
- A release announcement for software users. Use `paperclipai/optional/content/release-announcement`.
- Making the actual picture or video. Write the brief here, then use `paperclipai/optional/media/media-studio-generation`.

## Hard rules

- **Nothing is published without approval. Ever.** Every post (text, media, time, account) goes into an approval / confirmation request first (see the `paperclip` skill). This also applies to replies and comments on the company's accounts.
- **No invented facts, prices, discounts, quotes or testimonials.** Use only what the brief, the website or an approved source says. Never imply an endorsement that does not exist.
- **Respect rights.** Only use images, music and video the company owns, licensed, or generated for this purpose. Never use someone's photo, name or logo without permission. Credit where required.
- **Brand voice wins.** If the company has a voice guide, follow it. If not, ask once for 2–3 example posts the owner likes and match them; meanwhile write plain, friendly and concrete.
- **Disclose ads and partnerships** clearly (e.g. "Ad", "Paid partnership") when money or free products are involved.
- **No engagement bait** ("comment YES", "tag 5 friends") and no reacting to sensitive news or tragedies unless the owner asks.

## Platform cheat sheet

Check the platform's own help pages if a rule matters; platforms change limits often.

| Platform | Best format | Aspect ratio | Caption length | Hashtags |
|---|---|---|---|---|
| Instagram feed | Photo, carousel (up to 10), Reel | 4:5 (1080×1350) or 1:1; Reels 9:16 | Hook in first 125 chars; max 2 200 | 3–8 relevant |
| Instagram Stories | Photo/video, stickers | 9:16 (1080×1920) | Very short, on-image text | 0–2 |
| Facebook | Photo, short video, link post | 4:5 or 1:1; video 9:16 or 16:9 | 40–80 chars works best | 0–3 |
| LinkedIn | Text + image, document carousel, short video | 1:1 or 4:5; documents as PDF | Hook in first 2 lines (~210 chars); max 3 000 | 3–5 |
| X (Twitter) | Short text + image/video | 16:9 or 1:1 | 280 chars (free accounts) | 0–2 |
| TikTok | Vertical video 15–60 s | 9:16 (1080×1920) | Short; max 2 200 | 3–5 |
| YouTube Shorts | Vertical video up to 60 s | 9:16 | Title under 100 chars | 2–3 in description |

## Procedure

1. **Read the brief:** goal (awareness, sales, event, hiring), audience, platforms, period, offers or dates, must-say and must-not-say.
2. **Draft a content calendar** for the period: date, time (with time zone), platform, theme, format. Mix content types (roughly: helpful/educational, behind-the-scenes, product/offer, community). Do not post the same text on every platform — adapt it.
3. **Write each post:** hook first line, one message per post, clear call to action, platform-fit length, hashtags last, alt text for every image.
4. **Brief the visuals:** for each post, a short media brief (subject, style, aspect ratio, text on image, brand colours) to be produced with `paperclipai/optional/media/media-studio-generation`, or name the existing asset to use.
5. **Self-check** each post against the hard rules and the cheat sheet.
6. **Ask for approval** with the full calendar and every post. Note anything you assumed.
7. **After publishing (when asked to report):** per post — reach/impressions, engagement (likes, comments, shares, saves), clicks, followers gained; top 3 and bottom 3 posts with a one-line "why"; 2–3 concrete changes for next period. Use only numbers from the platform's own insights and say where they came from.

## Output template

```md
# Social plan — <period>, <time zone>

**Goal:** <goal> · **Platforms:** <list> · **Assumptions:** <list>

| # | Date & time | Platform | Format | Theme | Status |
|---|-------------|----------|--------|-------|--------|
| P1 | Mon 3 Nov 09:00 | Instagram | Carousel (4:5) | <theme> | Waiting for approval |

## P1 — Instagram carousel
**Caption:**
> <hook line>
> <body>
> <call to action>
> #tag1 #tag2 #tag3
**Alt text:** <description>
**Visual brief:** <subject, style, ratio, text on image> (or: use asset <name>)
```

## Done when

- [ ] Every post fits its platform's format and length.
- [ ] Every claim, price and date comes from the brief or an approved source.
- [ ] Every image has alt text and a visual brief or a named asset.
- [ ] The whole plan is waiting in an approval; nothing was published.
