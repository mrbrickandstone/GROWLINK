# Design brief reconciliation

Reviewed October 13, 2026 for East End Flower Farm Ltd. Source file hashes and local paths are recorded in `pilot/results/2026-10-13-design-briefs.json`. Both PDFs were read in full; diagrams and relevant tables were also rendered for visual review. The source PDFs were not modified or deployed.

## Authority and actual evidence

The user's direct request governs the work: inspect first, prioritize reuse of installed Ring cameras, run an official one-camera historical pilot before the full application, preserve production, and purchase nothing. The PDFs supply design requirements, assumptions and candidate technologies. Their procedural language does not independently authorize purchases, messages to vendors, production changes or a declaration of compliance.

The feasibility study explicitly says no camera account, site plan or power circuit was inspected. Its eight-camera budget is illustrative. Actual API inventory found three cameras; the owner identifies camera “1” as Indoor Cam 2K. The owner initially confirmed **Motion-Based Recording** and a required paid add-on, then reported upgrading the plan and enabling 24/7. The conservative earliest sample time is October 13 at 18:08 UTC; older quiet metadata cannot establish continuous footage. See the evolving pilot report for actual export results.

## Decisions reconciled against the repository

| Brief direction | Decision / implementation boundary |
|---|---|
| Local recorder preferred; Ring conditional (feasibility pp. 1, 3; architecture pp. 1-2) | Preserve the user's Ring-first evaluation. Ring remains supplemental until the newly enabled 24/7 export pilot and vendor gates pass. Evaluate a commercial recorder if technical/vendor gates fail. Do not claim Ring's API cannot export continuous footage from the current configuration |
| Reuse existing Vercel project versus dedicated security project (feasibility p. 3; architecture p. 6) | Reuse reviewed components and visual language. A separate security deployment/project is the proposed production destination, with named access and separate credentials. No security production release or new project has been provisioned |
| Next.js/TypeScript proposed (architecture p. 6) | Existing production is static HTML/CSS/JavaScript plus Node functions. Do not replace it merely to match a proposed framework. Source interfaces are TypeScript declarations; a framework choice follows validated source/media/auth needs |
| Source adapter operations (architecture p. 2) | Contracts now cover discovery, recording status, actual intervals, original export, viewer sessions and native evidence export. Unsupported/unverified are explicit outcomes, separate from successful empty coverage. These are interfaces, not working recorder adapters |
| Recording independent of Growlink/dashboard (both briefs) | Capture and scheduling belong to the recorder or Ring service. Read/export-only edge agent; no capture controls in the initial adapter. Viewer sessions are separate explicit actions and cannot be used by ingestion to manufacture footage |
| Native evidence versus browser playback (architecture pp. 2, 5) | Track vendor-native versus vendor-delivered bytes, known vendor transformations, actual bounds and native verifier. Keep standard copies/stills separate. Ring API media must not be described as untouched camera-native evidence merely because it was hashed |
| 90-day originals lock from ingestion (architecture p. 5) | Proposed approved local-recorder policy: retain originals at least until the later of ingestion + 90 days and capture end + 60 days. Holds can extend it. Do not enable irreversible Ring locks while deletion/retention terms remain unresolved |
| Holds include rolling recorder and late arrivals (architecture p. 5) | Hold contracts track pending/confirmed/failed state and native-source preservation. Pending protection blocks deletion; upload acknowledgment alone cannot confirm a hold |
| Owner/operator/technician/inspector roles (architecture p. 6) | Include those named roles plus auditor. Owner administration requires MFA; technicians cannot release holds; inspectors are scoped and read-only. Types do not implement authorization |
| Immediate inspector revocation (architecture p. 6) | Viewer contract distinguishes a gateway that checks grants on every request from expiry-only URLs. Ring inspector access stays gated on vendor clarification and request-specific authorization |
| Five-minute notification and separate archive lag targets (architecture p. 7) | Adopt proposed 30-second heartbeats, 90-second missing-heartbeat fault, recording freshness every 30-60 seconds, detection within 120 seconds and dispatch within 30 seconds. Verify receipt within five minutes. One-hour archive lag / six-hour backlog escalation never delays failure notifications |
| Evidence-based health (architecture p. 7) | Preserve independent capture/archive/retention/access observations with times and evidence. Add degraded state; missing/stale evidence is not green. Frozen-frame checks remain heuristics |
| Site scaling and eight-camera sizing (architecture p. 8) | Add site/provider/module identifiers. Mattituck remains future scope with its own site equipment and permissions. Owner mapping is now 1/3 → FLOWERING and 2 → FRONT DOOR; measured aggregate bitrate/load and floor plan remain missing; no quantities are approved for purchase |

## Expanded pilot and acceptance

The current code supports an initial adjacent-window smoke test, not a completed seven-day engineering pilot. After a camera records continuously under a valid subscription, select several consecutive quiet hours after both app consent and enablement. Use five-minute segments, then additional small-overlap boundary probes and separate day/night samples. The runner now supports explicit planned lookback, with consent/history checks including that margin. A separate real overlap run covers its declared target completely; earlier individual boundary offsets remain in the ledger. The signed cloud media transport operated during the completed pilot and was subsequently retired; actual results and limitations are recorded in the pilot report.

The brief's sequence is: source access/terms; complete media/timestamps/native evidence; power/failure/coverage drills; retention and procedures. A seven-day pilot cannot demonstrate a 60-day archive. Record day-61 and day-91 playback/coverage checks when those ages actually exist. Do not fabricate dates, failure receipts or power results. No scheduled automation or notification has been enabled by this document.

For real recovery tests, stop the export worker during a transfer, preserve the lease/partial file, restart, reconcile and compare original hashes and coverage. A new inventory process after refresh is useful credential evidence but does not establish interrupted-transfer recovery. Do not force production account revocation or corrupt its token record.

## Verified sources and unresolved vendor questions

Ring program requirements §2.4 restrict monitoring Amazon-service availability/performance/functionality; §2.8 restrict certain consequential-risk uses; §§2.10-2.11 address retained user data and deletion requests. Their application to regulated recording, archive health and mandatory holds needs written clarification. The pilot does not settle these issues, and private deployment does not waive them. [Ring program requirements](https://developer.amazon.com/docs/ring/program-requirements.html)

The June 8, 2026 release notes describe mandatory server-added API watermarks; September notes describe encryption that can make media unreadable or devices unavailable. Preserve delivered bytes and record these limitations. A watermark timestamp or E2EE=false observation alone cannot establish capture-time accuracy or camera-origin authenticity. [Ring release notes](https://developer.amazon.com/docs/ring/release-notes.html)

The public-safety policy requires request-specific consent and immediate revocation for covered access, and restricts state/federal direct access without separate legal process. Whether OCM inspection falls within those provisions is unresolved; owner consent alone must not be treated as resolving that question. [Ring content policy §4.3](https://developer.amazon.com/docs/ring/content-policy.html)

B2 compliance retention cannot be removed early, whereas governance can be overridden with appropriate authority; legal holds are separately managed. B2 remains a candidate, not a provisioned archive or permission to irreversibly lock Ring media. [B2 Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock)

The OCM source confirms the brief's minimum 60-day footage retention, embedded synchronized time, proprietary authentication plus standard export, five-minute alerts, eight-hour backup, inspections no more than 30 days apart and five-year test records. Applicable incidents require immediate notice within 24 hours, a report within ten calendar days and records for five years or the open investigation, whichever is longer. Certain alarm/video failures expected beyond eight hours are listed. Site/license applicability, approved security plan and acceptance of a specific evidence format still require review. No software feature establishes compliance. [OCM §125.3](https://cannabis.ny.gov/adopted-au-regulations)

Questions prepared for vendor/qualified review; **not sent**:

1. Does the official Ring historical endpoint expose every interval of Indoor Cam 2K 24/7 footage, including zero-event periods? What are the applicable rate, volume, latency and recovery limits?
2. Is unattended bulk export into an independent 60/90-day archive permitted for this private business application?
3. How do deletion requests and withdrawal of consent interact with statutory retention, pending investigations and immutable holds?
4. Is recording/archive freshness monitoring permitted under §2.4, and is the intended use acceptable under §2.8?
5. Does OCM request-specific inspection fall under §4.3's state-agency restrictions, and what additional process is required?
6. Which authenticated source-native package/verifier, if any, is available through supported Ring interfaces? What does the visible timestamp represent, and how can original capture time be independently validated?

## Concrete next inputs

Ring route: owner reports the plan upgrade and 24/7 activation. Verify subsequent historical exports, independent power/mode behavior, vendor authorization and native evidence suitability. The agent made no purchase or recording change. Earlier candidate timestamps cannot be assumed to contain continuous footage.

Recorder route: demo/loan or access to an existing commercial recorder and compatible cameras; official historical/export API or SDK; read/export service account; native signed bundle and offline verifier; recording/time-sync/storage configuration; site coverage plan, measured network capacity and whole-chain power inventory. Axis remains a documented evidence-oriented candidate; UniFi in the brief is an alternative requiring its own export/authenticity test. No final hardware choice or bill of materials is approved.

The separate development application is described in [the security runbook](../../security/README.md). Its implementation does not close the source/vendor/site acceptance gates above.
