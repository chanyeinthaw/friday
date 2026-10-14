# Firecrawl API facts for per-user integration

Checked 2026-10-14 against Firecrawl's current first-party API reference, product docs, pricing page, and rate-limit docs.

## Search API v2

Call `POST https://api.firecrawl.dev/v2/search` with `Authorization: Bearer <API_KEY>`, `Content-Type: application/json`, and a JSON body. `query` is required and has a 500-character maximum. `limit` is optional, defaults to 10, and accepts 1–100; with multiple sources it applies independently to each source. `sources` defaults to web results. `scrapeOptions` is optional and adds page content extraction. [Search API reference](https://docs.firecrawl.dev/api-reference/endpoint/search) · [Search guide and examples](https://docs.firecrawl.dev/features/search)

The REST success response has `success` and `data`; `data.web` contains search result objects with `url`, `title`, and `description`, plus fields such as `markdown` when scraping is requested. Other result arrays depend on requested `sources`. The response also documents top-level `warning`, `id`, and `creditsUsed`; `creditsUsed` is the actual integer charged for that search. [Search API reference](https://docs.firecrawl.dev/api-reference/endpoint/search) · [Search response example](https://docs.firecrawl.dev/features/search)

```json
{
  "success": true,
  "data": {
    "web": [{ "url": "https://example.com", "title": "Example", "description": "..." }]
  },
  "id": "search-job-id",
  "creditsUsed": 2
}
```

## Team credit balance

Call `GET https://api.firecrawl.dev/v2/team/credit-usage` with `Authorization: Bearer <API_KEY>`. It takes no query parameters or body. A successful response is:

```json
{
  "success": true,
  "data": {
    "remainingCredits": 1000,
    "planCredits": 1000,
    "billingPeriodStart": "2025-01-01T00:00:00Z",
    "billingPeriodEnd": "2025-01-31T23:59:59Z"
  }
}
```

`remainingCredits` and `planCredits` are numbers. `billingPeriodStart` and `billingPeriodEnd` are date-time strings or `null`. `planCredits` is the plan's allowance and explicitly excludes coupon credits and pay-as-you-go credits. This is the authenticated **team's** balance, so display `remainingCredits` as the available balance and treat `planCredits` as a separate allowance figure. A missing balance returns HTTP 404 with `{ "success": false, "error": "Could not find credit usage information" }`. [Credit Usage API reference](https://docs.firecrawl.dev/api-reference/endpoint/credit-usage)

The API uses bearer authentication; Firecrawl's docs show a user-supplied API key in that header. Rate limits and balances are team scoped: all keys on one team share rate-limit counters. [Search API reference](https://docs.firecrawl.dev/api-reference/endpoint/search) · [Rate limits](https://docs.firecrawl.dev/rate-limits)

## Free allowance, search cost, and limits

The Free plan gets **1,000 credits every month** (recurring, not just a one-time signup grant), costs $0, and requires no card. Searches and pages share this balance: the base allowance is described as about 500 searches or 1,000 scraped pages. [Pricing and billing FAQ](https://www.firecrawl.dev/pricing)

Standard search costs **2 credits per 10 results, rounded up**: 1–10 results cost 2 credits; 11–20 cost 4. If `scrapeOptions` are enabled, add normal scraping costs: 1 credit per webpage, 1 per PDF page, and 4 additional credits per webpage for JSON mode. Use the response's `creditsUsed` for the actual charge rather than calculating it from the requested limit. [Search cost details](https://docs.firecrawl.dev/features/search) · [API credit cost table](https://www.firecrawl.dev/pricing)

On Free, `/search` is limited to **10 requests per minute**; exceeding a rate or concurrency limit returns HTTP 429. The rate-limit counter is shared by all API keys belonging to the same team. [Rate limits](https://docs.firecrawl.dev/rate-limits)
