/** Contracts only. No adapter, authorization service or archive is commissioned by these types. */
export type UTCMilliseconds = number;
export type EvidenceState = 'unknown' | 'verified' | 'degraded' | 'failed' | 'stale';
export type SourceMode = 'ring-supplemental' | 'ring-primary-qualified' | 'commercial-recorder';
export interface Capability {
  state: 'verified' | 'unverified' | 'unsupported';
  observedAt: UTCMilliseconds | null; evidenceId: string | null; detail: string;
}
export interface SourceCapabilities {
  recordedIntervals: Capability; historicalOriginals: Capability;
  nativeEvidence: Capability; liveViewer: Capability; historicalViewer: Capability;
}
export interface Camera {
  id: string; siteId: string; providerId: string; componentId: string | null;
  source: SourceMode; sourceQualificationEvidenceId: string | null; name: string;
  location: string; room: string; model: string | null; configurationVersion: string;
  powerSource: 'poe' | 'plug-in' | 'hardwired' | 'battery' | 'unknown';
  capabilities: SourceCapabilities;
  capture: Observation; archive: Observation; retention: Observation; access: Observation;
}
export interface Observation { state: EvidenceState; observedAt: UTCMilliseconds | null; evidenceId: string | null; detail: string }
/** Half-open [start,end) bounds. Every request must authorize site and camera scope. */
export interface Window { siteId: string; cameraId: string; componentId?: string; start: UTCMilliseconds; end: UTCMilliseconds }
/** Unsupported/unverified is explicit; never convert either to empty verified coverage. */
export type SourceResult<T> =
  | { kind: 'available'; value: T }
  | { kind: 'unsupported' | 'unverified'; reason: string; nativeFallback?: string }
  | { kind: 'failed'; code: string; retryable: boolean; retryAt: UTCMilliseconds | null };
export interface RecordingStatus {
  observation: Observation; basis: 'recorded-media' | 'provider-status' | 'inference';
  latestRecordedInterval: RecordedInterval | null; errors: string[];
}
export interface CoverageGap extends Window { reason: string; lastCheckedAt: UTCMilliseconds }
export interface RecordingListing {
  intervals: RecordedInterval[]; gaps: CoverageGap[]; queried: Window;
  enumerationComplete: boolean; observedAt: UTCMilliseconds;
}
export interface RecordingSource {
  discoverCameras(siteId: string): Promise<SourceResult<Camera[]>>;
  getRecordingStatus(camera: Camera): Promise<SourceResult<RecordingStatus>>;
  /** Actual source intervals; event listings never satisfy this contract. */
  listRecordedIntervals(window: Window): Promise<SourceResult<RecordingListing>>;
  /** Retrieve pre-existing media only. Preserve requested and actual bounds separately. */
  exportOriginal(window: Window): Promise<SourceResult<OriginalExport>>;
  /** Explicit authorized viewer request only; ingestion must never call this operation. */
  createViewerSession(request: ViewerRequest): Promise<SourceResult<ViewerSession>>;
  exportEvidence(request: EvidenceRequest): Promise<SourceResult<NativeEvidenceBundle>>;
}
export interface RecordedInterval extends Window { sourceRecordingId: string; timestampBasis: string }
export interface OriginalExport {
  bytes: AsyncIterable<Uint8Array>; sourceRecordingId: string; mediaType: string;
  requested: Window; actualStart: UTCMilliseconds | null; actualEnd: UTCMilliseconds | null;
  completeness: 'complete' | 'partial' | 'unknown';
  /** Ring API bytes may already be watermarked/transformed by the vendor. */
  provenance: 'vendor-native' | 'vendor-delivered' | 'unknown';
  vendorTransformations: string[]; timestampBasis: string | null;
  authenticationFile?: AsyncIterable<Uint8Array>; sourceFormat: string;
}
export interface ViewerRequest {
  requestId: string; userId: string; grantId: string; camera: Camera;
  mode: 'live' | 'playback'; window?: Window;
}
export interface ViewerSession {
  sessionId: string; expiresAt: UTCMilliseconds;
  /** Sensitive session URL; never include in audit logs or a public camera registry. */
  url: string; kind: 'authorized-gateway' | 'native-viewer';
  revocation: 'checked-on-every-request' | 'expiry-only';
}
export interface EvidenceRequest {
  requestId: string; incidentId: string; userId: string; grantId: string;
  intervals: RecordedInterval[];
}
export interface EvidenceFile {
  name: string; bytes: AsyncIterable<Uint8Array>; mediaType: string;
  role: 'native-original' | 'vendor-verifier' | 'vendor-authentication' | 'standard-copy' | 'still';
}
export interface NativeEvidenceBundle {
  sourceFormat: string; files: EvidenceFile[]; actualIntervals: RecordedInterval[];
  missingIntervals: CoverageGap[]; authenticity: Observation;
  vendorVerifierReference: string | null;
}
export interface ArchiveReceipt {
  objectKey: string; versionId: string; sha256: string; size: number;
  ingestedAt: UTCMilliseconds; readbackVerifiedAt: UTCMilliseconds; retainUntil: UTCMilliseconds;
  legalHold: boolean; immutableStorageVerified: boolean;
  retentionMode: 'none' | 'governance' | 'compliance'; policyDecisionId: string;
}
export interface RetentionPolicy {
  targetDays: 90; minimumRequiredDays: 60;
  originalLockAnchor: 'ingestion'; originalLockDays: 90;
  /** No irreversible Ring lock while vendor retention/deletion clearance is unresolved. */
  vendorPolicyStatus: 'unresolved' | 'approved'; policyDecisionId: string | null;
}
export interface HoldReceipt {
  investigationId: string; objectKey: string; versionId: string;
  state: 'pending' | 'confirmed' | 'failed'; observedAt: UTCMilliseconds;
  nativeSourcePreservation: Observation;
}
export interface IndependentArchive {
  /** Idempotency keys cannot overwrite previously stored evidence with different bytes. */
  putOriginal(input: OriginalExport, idempotencyKey: string, retainUntil: UTCMilliseconds): Promise<ArchiveReceipt>;
  verify(receipt: ArchiveReceipt): Promise<boolean>;
  /** Pending holds block deletion and must include late-arriving footage. */
  setHold(receipt: ArchiveReceipt, investigationId: string): Promise<HoldReceipt>;
}
export type NamedRole = 'owner' | 'operator' | 'technician' | 'inspector' | 'auditor';
export interface InspectorGrant {
  requestId: string; userId: string; siteId: string; cameraIds: string[]; start: UTCMilliseconds; end: UTCMilliseconds;
  expiresAt: UTCMilliseconds; approvedBy: string; consentRecordedAt: UTCMilliseconds; revokedAt: UTCMilliseconds | null;
  ownerNotifiedAt: UTCMilliseconds; purpose: string; vendorPolicyDecisionId: string | null;
}
