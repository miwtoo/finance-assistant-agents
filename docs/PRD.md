## Problem Statement

The user wants better financial visibility, but previous attempts to track every transaction manually in Google Sheets failed because recording every transaction was too painful.

Thailand daily spending often produces digital banking slip images, especially for online payments, but the user does not want to manually re-enter every small meal, transfer, convenience store payment, or app payment into a finance ledger.

The user wants Firefly III to remain the final ledger/source of truth, but the immediate pain is not dashboarding or financial planning yet.

The immediate pain is getting real spending into Firefly safely with minimal friction.

The MVP must prove that synced banking slip images can become reviewed Firefly expense transactions without creating trust-breaking mistakes.

The two trust breakers are duplicate transactions synced to Firefly and wrong amounts synced to Firefly.

## Solution

Build MVP 0 as a small personal web workflow that turns banking slip images into reviewed Firefly expense transactions.

The user’s Android banking apps already save slip images into phone folders, and Resilio Sync already fits the user’s daily workflow for syncing images between Android devices, so MVP 0 should use Resilio-synced slip images as the input source.

The user opens a Pi-hosted web UI protected by Cloudflare Access, scans a selected date range from the synced slip folder, parses slip images with Gemini vision, reviews drafts beside the original slip image, fixes any required fields, resolves duplicate risk, and explicitly confirms the final sync to Firefly.

Firefly III remains the source of truth for final accounts, categories, destination expense accounts, and synced transactions.

The local app exists only to manage slip discovery, parsing history, review state, matching rules, duplicate-risk handling, skipped slip history, and Firefly sync status.

MVP 0 is complete when the system can process real slip images from the synced raw folder into safe Firefly expense transactions with clear review and confirmation.

## User Stories

1. As the user, I want banking slip images from my Android phone to be available to the app automatically, so that I do not need to manually upload every daily payment.
2. As the user, I want the app to use my existing Resilio Sync workflow, so that the MVP adds minimal new behavior to my daily routine.
3. As the user, I want the app to scan synced slip images from a raw folder, so that I can process existing banking slip images without building a mobile app first.
4. As the user, I want to select a date range before scanning, so that I can control which slips are considered for processing.
5. As the user, I want the date range to use file metadata only as a candidate filter, so that the actual accounting date still comes from the slip content.
6. As the user, I want the app to parse eligible slip images with Gemini vision, so that amount, date, currency, merchant, source identifier, and category guess are extracted automatically.
7. As the user, I want parser failures to be visible, so that failed slips do not disappear silently.
8. As the user, I want parser failures to be retryable or skippable, so that a failed image does not block the rest of the batch.
9. As the user, I want every discovered slip to have a clear lifecycle status, so that I can answer what happened to any image.
10. As the user, I want skipped slips to remain visible in history, so that skipped images do not disappear from the workflow.
11. As the user, I want duplicate-risk slips to be clearly marked, so that duplicate transactions do not get into Firefly accidentally.
12. As the user, I want duplicate-risk slips to be blocked from normal final sync until resolved, so that Firefly is protected from duplicate expenses.
13. As the user, I want the system to detect exact duplicate images, so that the same slip file is not parsed or synced twice.
14. As the user, I want the system to detect likely duplicate transactions, so that re-saved, re-downloaded, or similar slip images do not create duplicate Firefly entries.
15. As the user, I want the original slip image shown beside the parsed draft, so that I can verify the amount and details before sync.
16. As the user, I want all draft fields to be editable before sync, so that I can recover from imperfect AI parsing.
17. As the user, I want the app to require date before sync, so that Firefly receives a valid transaction date.
18. As the user, I want the app to require amount before sync, so that Firefly does not receive incomplete transactions.
19. As the user, I want the app to require currency before sync, so that THB and foreign-currency spending do not get mixed silently.
20. As the user, I want missing currency to default to THB but require review, so that normal Thai slips are fast while unclear slips stay safe.
21. As the user, I want the app to require merchant before sync, so that the Firefly destination is meaningful.
22. As the user, I want the app to store both parsed merchant and normalized merchant, so that the original extracted text is preserved while Firefly stays clean.
23. As the user, I want normalized merchant name to be used as the Firefly destination account name, so that merchant reporting in Firefly is readable.
24. As the user, I want merchant aliases to be learned from my review edits, so that repeated merchant cleanup becomes easier over time.
25. As the user, I want merchant alias rules to support exact and contains matching first, so that matching stays understandable in MVP 0.
26. As the user, I want the app to require source account before sync, so that spending is assigned to the correct Firefly account.
27. As the user, I want source account matching to come from identifiers parsed from the slip image, so that ambiguous folders like K PLUS do not map to the wrong bank account or card.
28. As the user, I want drafts without a recognized source account identifier to be blocked until I choose the Firefly account, so that the wrong payment source is not synced.
29. As the user, I want Firefly asset accounts to be imported into the app, so that local source matching is tied to Firefly account records.
30. As the user, I want to attach slip-visible identifiers to imported Firefly accounts, so that future slips can match the right source account.
31. As the user, I want credit cards to be usable as payment sources in the same MVP sync flow, so that slips paid from card-like sources can still become expenses when a slip image exists.
32. As the user, I want the app to require category before sync, so that Firefly category reporting is useful.
33. As the user, I want a small default category set, so that review stays simple and practical.
34. As the user, I want categories to sync directly to Firefly using the same names, so that Firefly remains the source of truth.
35. As the user, I want missing Firefly categories to be created automatically if needed, so that setup friction stays low.
36. As the user, I want category memory to attach to the normalized merchant, so that aliases of the same merchant share category behavior.
37. As the user, I want category memory to remember my last approved category for a merchant, so that repeated predictable merchants become faster to review.
38. As the user, I want ambiguous merchants to require category confirmation even when a remembered category exists, so that merchants like 7-Eleven, Big C, Lotus’s, Shopee, Lazada, Grab, Tops, Makro, and Central do not silently use the wrong category.
39. As the user, I want ambiguous merchants to show the remembered category as a suggestion, so that review is still quick.
40. As the user, I want inline category confirmation for ambiguous merchants, so that I can resolve common cases without opening a heavy editor.
41. As the user, I want drafts split into ready-to-sync and needs-review groups, so that low-risk drafts can be handled separately from risky drafts.
42. As the user, I want an approve-all-ready action, so that safe drafts can be approved efficiently while blocked drafts stay separate.
43. As the user, I want Firefly writes to happen only after an explicit sync action, so that parsing and review cannot mutate the final ledger by accident.
44. As the user, I want a final confirmation before Firefly sync, so that the last write action is intentional.
45. As the user, I want the final confirmation to show transaction count, total amount by currency, transaction list, duplicate-risk warnings, and excluded blocked items, so that I can sanity-check the batch before Firefly changes.
46. As the user, I want MVP 0 to create only Firefly expense/withdrawal transactions, so that the first build stays focused on spending capture.
47. As the user, I want non-expense slips to be skipped manually, so that transfers, repayments, salary, refunds, and top-ups do not require a classifier in MVP 0.
48. As the user, I want sync status and transaction type to be treated as separate concepts, so that workflow history does not become confused with accounting meaning.
49. As the user, I want synced drafts to become read-only locally, so that Firefly remains the final source of truth after sync.
50. As the user, I want post-sync corrections to happen in Firefly for MVP 0, so that the app does not need bidirectional sync.
51. As the user, I want the Firefly transaction description to stay clean, so that Firefly remains usable for daily finance review.
52. As the user, I want compact audit fields in Firefly notes, so that I can trace a transaction back to the source slip if needed.
53. As the user, I want noisy parser/debug details to stay local, so that Firefly does not become cluttered with AI internals.
54. As the user, I want the app to preserve review and sync history, so that it never becomes unclear whether a slip was reviewed or synced.
55. As the user, I want the system to prefer safe failure over silent sync, so that uncertain slips require action instead of corrupting the ledger.
56. As the user, I want to use Cloudflare Access as the public auth layer, so that the personal web UI can be protected without building custom auth.
57. As the user, I want Firefly credentials and Gemini credentials to stay on the Pi, so that secrets are not managed in the browser UI.
58. As the user, I want slip images to be sent to Gemini only for parsing, so that the privacy tradeoff is bounded to the MVP’s extraction job.
59. As the user, I want incomplete spending coverage to be acceptable in MVP 0, so that the workflow can prove value before adding manual receipts, statements, and planning.
60. As the user, I want no dashboard in MVP 0, so that effort stays focused on making Firefly sync work.
61. As the user, I want to view financial summaries in Firefly for now, so that the MVP does not duplicate Firefly reporting.
62. As the user, I want manual entry and receipt upload out of scope, so that the first build avoids complex paper receipt and credit card statement flows.
63. As the user, I want credit-card spending without slip images out of scope, so that the first dataset can be incomplete but reliable.
64. As the user, I want MVP 0 to be considered successful when real slip images can be reviewed and safely synced, so that the build has a concrete finish line.
65. As the user, I want the first acceptance proof to use any real slip images from the raw folder, so that the test reflects the actual workflow without requiring source-app coverage.
66. As the user, I want parser imperfections to be acceptable when visible and recoverable, so that the MVP is judged by safety and workflow trust rather than perfect AI extraction.
67. As the user, I want wrong amount and duplicate sync to be treated as unacceptable, so that the final ledger stays trustworthy.
68. As the user, I want wrong category, messy merchant, missing account, skipped slip, and parser failure to be acceptable before sync if visible and fixable, so that the review loop can absorb uncertainty.
69. As the user, I want MVP 0 complete once slip-based expenses safely sync to Firefly, so that dashboard, planning, and automation do not delay the first useful version.

## Implementation Decisions

- Build MVP 0 around one product promise: trusted banking slip image to Firefly expense sync.
- Use Firefly III as the final ledger and source of truth.
- Do not build a dashboard for MVP 0 because the user will use Firefly for financial visibility after sync.
- Use Resilio Sync as the slip image transport layer because it is already part of the user’s daily workflow.
- Use a Pi-hosted web UI as the user-facing review and sync surface.
- Protect the Pi-hosted web UI with Cloudflare Access rather than building custom app authentication for MVP 0.
- Use Gemini vision as the first parser provider for slip image extraction.
- Keep the parser behind an internal provider boundary so that other OCR or vision providers can be considered later without changing product requirements.
- Scan one raw slip image area recursively instead of requiring per-folder configuration for MVP 0.
- Let the user choose start date and end date before scanning.
- Use file metadata only to find candidate images for the selected date range.
- Use parsed slip date as the final transaction date for Firefly.
- Track each slip image through a visible lifecycle so no image disappears from the user’s perspective.
- Deduplicate exact image files before unnecessary parsing where possible.
- Detect parsed duplicate-risk transactions and block them until the user resolves them.
- Create parsed drafts locally before any Firefly write.
- Show the original slip image beside parsed draft fields during review.
- Allow all draft fields to be edited before sync.
- Require date, amount, currency, merchant, source account, and category before sync.
- Default missing currency to THB but require review when currency is not clearly present.
- Store both parsed merchant and normalized merchant.
- Use normalized merchant as the Firefly destination expense account name.
- Learn merchant aliases from review edits.
- Support exact and contains alias matching in MVP 0.
- Import Firefly asset accounts into the app for source account selection and matching.
- Match source accounts only from identifiers parsed from the slip image and the local account registry.
- Do not map source accounts from folder names.
- Block sync when the source account cannot be matched or manually selected.
- Use a small fixed category list in MVP 0: Food, Coffee / Drink, Convenience Store, Household, Transport, Shopping, Subscription, Bill / Utility, Health, Entertainment, Travel, Other, and Unknown.
- Sync categories directly to Firefly using the same category names.
- Create missing Firefly categories automatically when needed.
- Store category memory against normalized merchant names.
- Maintain an editable ambiguous merchant list, initially including 7-Eleven, Big C, Lotus’s, Shopee, Lazada, Grab, Tops, Makro, and Central.
- Require category confirmation for ambiguous merchants even when a category memory suggestion exists.
- Provide inline category confirmation for ambiguous merchants in the review UI.
- Split review queues into ready-to-sync and needs-review groups.
- Provide an approve-all-ready action for drafts that pass all safety checks.
- Treat review state, sync state, and transaction type as separate concepts.
- Support only expense transaction sync in MVP 0.
- Use skip as the manual action for slips that should not become Firefly expenses.
- Keep skipped slips visible in history.
- Require final confirmation before Firefly writes.
- Show transaction count, total amount by currency, included transactions, duplicate-risk warnings, and excluded blocked items in final confirmation.
- Write only clean user-facing transaction data into Firefly fields.
- Use normalized merchant name as the Firefly description.
- Put compact audit fields in Firefly notes, such as source path, content hash, slip reference, and parsed merchant.
- Keep raw parser response, confidence, prompt/model metadata, validation diagnostics, and review history local only.
- Treat Firefly sync as one-way in MVP 0.
- Lock local drafts after successful sync and route later corrections to Firefly.
- Store Firefly base URL and personal access token in environment configuration on the Pi rather than editing secrets in the UI.
- Store Gemini credentials on the Pi.
- Do not build cron, background automation, manual upload, paper receipt parsing, statement import, transfers, refunds, salary, recurring payments, or planning in MVP 0.

## Testing Decisions

- The highest-value test seam is the end-to-end user workflow from scanned slip candidates through draft review, final confirmation, and Firefly transaction creation.
- Tests should focus on externally visible behavior rather than implementation details.
- A good test proves that a slip image can become a reviewed draft and then a Firefly expense only after required fields are present and the user confirms sync.
- A good test proves that wrong or missing required fields block sync until fixed.
- A good test proves that duplicate-risk slips cannot be included in final sync by accident.
- A good test proves that skipped slips remain visible in history.
- A good test proves that synced drafts are no longer editable locally as normal drafts.
- A good test proves that the original slip image is visible beside the parsed draft during review.
- A good test proves that ambiguous merchants require category confirmation even when a remembered category exists.
- A good test proves that normalized merchant is used for Firefly destination/description while parsed merchant is preserved for audit/debugging.
- A good test proves that source account matching uses parsed identifiers and does not rely on folder names.
- A good test proves that missing currency defaults to THB but stays review-required when unclear.
- A good test proves that final confirmation shows transaction count, total amount by currency, blocked/excluded items, and duplicate-risk warnings.
- The preferred acceptance test is to scan a chosen date range, process real eligible slip images from the raw folder, review/fix drafts, sync approved expenses to Firefly, and verify no duplicate or obviously wrong transaction reaches Firefly.
- Since the repository currently has minimal project structure, no prior test seams were found; the implementation plan should choose the highest available workflow seam once the app structure exists.
- Parser behavior should be testable with representative fixture images or parser-provider test doubles, but the product test should assert the draft/review/sync behavior rather than internal Gemini prompt details.
- Firefly behavior should be testable through a Firefly client boundary or staging/test Firefly instance, but the product test should assert the created expense transaction semantics rather than internal HTTP implementation.

## Out of Scope

- Dashboard or reporting UI.
- Full financial health summary.
- Safe-to-spend calculation.
- Budgeting and envelope planning.
- Salary forecasting.
- Recurring payments.
- Installments.
- Credit-card statement import.
- Credit-card spending without slip images.
- Manual expense entry.
- Manual receipt upload.
- Paper receipt line-item extraction.
- Item-level category splitting.
- Transfers between own accounts.
- Credit card repayments.
- Salary deposits.
- Refunds.
- Cashback.
- Investments.
- FX conversion beyond storing parsed currency and requiring review for non-THB or unclear currency.
- Cron/background parsing automation.
- Mobile app.
- Custom authentication inside the app.
- Firebase Auth.
- Bidirectional Firefly sync.
- Local post-sync editing or resync flows.
- Perfect parser accuracy requirements.
- Parser success-rate targets.
- Review speed targets.
- Multi-source-app acceptance coverage requirements.

## Further Notes

- MVP 0 is intentionally incomplete from a full financial-picture perspective.
- MVP 0 should label its scope mentally and in UI as slip-based expense sync only, even though no dashboard is being built.
- Missing spending coverage is acceptable because cash, statement-only card purchases, manual receipts, and skipped slips are out of scope.
- The first build should optimize for trust and visible workflow state over automation.
- The user is comfortable sending slip images to Gemini for parsing in MVP 0.
- The user accepts the tradeoff that slip images remain in the Resilio-synced source folders, while the app records metadata, review state, parse history, and Firefly sync status.
- Repository inspection found only a minimal README, so no ADRs or existing domain glossary were found to constrain this PRD.

