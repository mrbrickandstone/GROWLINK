# Cucumber / coco workspace

Open `/cucumber/` on the existing dashboard domain and use the existing dashboard password. This is a dedicated manual-entry cucumber workspace. It does not read the existing Growlink feed, existing crop profiles, learning archive or controller settings. No cucumber sensors are connected, and no sensor data has been fabricated or backfilled.

## First use

1. Name the actual cucumber growing area and enter the cultivar, growth stage, irrigation system, plant count and coco container volume where known. Unknown values remain blank or explicitly unknown.
2. Enter measured air temperature (°F), humidity (%), dripper/feed EC (mS/cm), collected drainage EC (mS/cm), and feed pH. A substrate-probe EC measurement is not a drainage-sample measurement. Confirm meter checks only if performed.
3. For a daily water comparison, enter applied and drained totals for the same counted group, collection start/end, and collection confirmations. Empty and zero are different. Collect drainage after the last irrigation. The program displays applied liters per measured plant, not an inferred water requirement or plant uptake.
4. Review the evidence and linked reference for each check. Record what you checked or changed as a follow-up linked to the reading. Add another entry to explain a correction; existing entries are append-only.

No seven-day waiting period is required to see reference checks. The seven-day history counts distinct New York calendar days with manual readings from the same setup and summarizes measured EC/pH values. These are sample statistics, not continuous coverage, calibrated crop targets, a trained model or proof of a successful treatment. Changes to area, cultivar, stage, irrigation system, plant count or container size begin a different comparison group. Setup details are preserved on each entry.

## Recommendation scope and references

The first version uses explicit versioned rules, not an LLM, external AI service or automatic equipment control. It surfaces measurement checks and review actions. It does not calculate fertilizer/acid doses, fixed irrigation volumes, controller timings, yield forecasts or pest treatments.

- [University of Florida, CV268](https://ask.ifas.ufl.edu/publication/CV268): feed pH reference and checks on potentially unfavorable temperature extremes. A spot temperature does not prove a sustained problem.
- [NSW Local Land Services, 2019 cucumber manual](https://soilwealth.com.au/wp-content/uploads/2023/08/Cucumberbook2019_LOW_RES2.pdf#page=113): flow-through substrate feed/drain EC references. See the general guidance on printed page 112; plant condition and growing environment affect actual targets.
- [Alabama Cooperative Extension, ANR-2926](https://www.aces.edu/blog/topics/crop-production/greenhouse-cucumber-production/): broad substrate daily leachate and humidity guidance. These are greenhouse starting references and are not specifically calibrated to the user's coco, cultivar or New York conditions.

The application distinguishes these references rather than merging unrelated measurement methods. Seedlings, unknown stages and recirculating/unknown systems do not receive the established, drain-to-waste EC/drainage checks. Chemistry comparisons require the user to confirm a meter standard check. Daily drainage review requires complete matched measurements with an actual measured-plant count.

Software freshness/completeness gates (engineering choices, not published crop targets): climate readings up to six hours old; chemistry up to 24 hours; collection end up to 36 hours old; daily collections between 20 and 28 hours. Older or incomplete entries remain visible but do not drive those current checks. Drainage exceeding applied volume is flagged for timing/scope/carryover review. Missing values are never interpolated.

## Storage, authentication and reliability

The new `/api/cucumber` endpoint uses the existing server-side dashboard password and writable Redis REST connection. Records use only the `horticulture:cucumber:coco:v1` namespace. No new credentials, model account, paid service, cron job, email recipient or external notification is added. Existing monitoring and Ring files are untouched.

GET serves setup, recent entries and a fresh assessment. POST accepts authenticated same-origin JSON for setup or records. The server enforces cucumber/coco scope, units, numeric bounds and explicit timestamps. Stable record IDs make retries idempotent; conflicting reuse is rejected. Setup revisions protect against concurrent edits. A record retry returns the original saved entry even if setup subsequently changed. A stale browser cannot silently tag a new reading with another session's updated setup.

Setup, entries and follow-ups remain stored. The UI and JSON download include up to 200 entries from the last 90 days, with this limit stated. The download contains potentially private operational notes and is initiated only by the user. Passwords remain in browser memory and clear on signout; notes render as plain text. Late requests cannot repopulate a signed-out workspace.

The profile and record validators persist only known fields. Each record stores its setup snapshot, origin, observation time, entry time and manual confirmations. Follow-ups never operate equipment or modify recommendation rules.

## Validation and release

Run `npm test`. Optional Redis/Lua contract tests use `fakeredis[lua]` with the existing `tests/redis-fixture.py`; this release ran them with Lua enabled. Cucumber tests cover boundary values, stale measurements, incomplete/partial collections, calibration and stage/system gates, setup isolation, retry idempotency, revision conflicts, positive API round trips and synthetic jsdom login/form/signout behavior. No test readings should be written into production.

The production smoke check verifies the new page/scripts and that unauthenticated GET/POST access to `/api/cucumber` returns 401. A real first setup and measurement are entered by the user with their password. Future sensor integration must use the actual cucumber area's confirmed sensor mapping and sample semantics; it must not reuse another growing area's feed.
