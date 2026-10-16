'use strict';
const crypto = require('node:crypto');

function windowRange(start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start)
    throw new Error('INVALID_WINDOW');
  return {start, end};
}

// Half-open UTC intervals; absent evidence is never treated as coverage.
function coverage(start, end, spans) {
  windowRange(start, end);
  const intervals = spans.filter(s => s.verified === true && Number.isSafeInteger(s.start) && Number.isSafeInteger(s.end) && s.end > s.start)
    .map(s => ({start: Math.max(start, s.start), end: Math.min(end, s.end)}))
    .filter(s => s.end > s.start).sort((a,b) => a.start-b.start);
  const merged = [];
  for (const item of intervals) {
    const last = merged.at(-1);
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else merged.push({...item});
  }
  let cursor = start;
  const gaps = [];
  for (const item of merged) {
    if (item.start > cursor) gaps.push({start: cursor, end: item.start});
    cursor = item.end;
  }
  if (cursor < end) gaps.push({start: cursor, end});
  return {intervals: merged, gaps, coveredMs: merged.reduce((n,s) => n+s.end-s.start, 0), requestedMs: end-start};
}

function jobKey(camera, component, start, end) {
  windowRange(start,end);
  return crypto.createHash('sha256').update(JSON.stringify(['ring-pilot-v1', camera, component ?? null, start, end])).digest('hex');
}

function assessMedia(request, response, probe) {
  const reasons = [];
  const start = response.timestamp;
  const measuredMs = Math.round(Number(probe?.durationSeconds) * 1000);
  if (![200,206].includes(response.status)) reasons.push('HTTP_NOT_MEDIA');
  if (!Number.isSafeInteger(start)) reasons.push('ACTUAL_TIMESTAMP_MISSING');
  if (!Number.isSafeInteger(measuredMs) || measuredMs <= 0) reasons.push('DURATION_UNVERIFIED');
  if (!probe?.decoded || !probe?.frameTimelineValid) reasons.push('DECODE_OR_FRAME_CONTINUITY_UNVERIFIED');
  if (!probe?.width || !probe?.height) reasons.push('IMAGE_DIMENSIONS_UNVERIFIED');
  if (response.status === 206 && !Number.isSafeInteger(response.length)) reasons.push('PARTIAL_DURATION_MISSING');
  // Container/partial duration disagreement is not repaired by assuming the requested duration.
  if (Number.isSafeInteger(response.length) && Math.abs(response.length-measuredMs)>100) reasons.push('DURATION_DISAGREEMENT');
  const actualEnd = Number.isSafeInteger(start) && Number.isSafeInteger(measuredMs) ? start + measuredMs : null;
  const verified = reasons.length === 0;
  const result = coverage(request.start, request.end, verified ? [{start, end:actualEnd, verified}] : []);
  return {verified, reasons, actualStart:start ?? null, actualEnd, measuredMs:Number.isFinite(measuredMs)?measuredMs:null,
    startDeltaMs:Number.isSafeInteger(start)?start-request.start:null, endDeltaMs:actualEnd===null?null:actualEnd-request.end,
    complete:verified && result.gaps.length===0, ...result};
}

module.exports = {coverage, windowRange, jobKey, assessMedia};
