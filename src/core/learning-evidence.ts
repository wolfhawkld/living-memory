import type { CalibrationSummary, LearningSummary, Observation } from '../shared/types.js';
import { isValidInstant } from './time-model.js';

function calibration(events: Observation[], task: 'concept' | 'scenario'): CalibrationSummary {
  const eligible = events.filter((event) => {
    const evidence = event.learning;
    return evidence?.task === task && evidence.cue === 'independent'
      && event.exposure === 'unexposed' && !event.observedExposure
      && (evidence.outcome === 'success' || evidence.outcome === 'failure')
      && (evidence.basis === 'self-check' || evidence.basis === 'application')
      && typeof evidence.confidence === 'number' && Number.isFinite(evidence.confidence)
      && evidence.confidence >= 0 && evidence.confidence <= 100
      && typeof evidence.confidenceAt === 'string' && isValidInstant(evidence.confidenceAt)
      && isValidInstant(event.observedAt) && Date.parse(evidence.confidenceAt) <= Date.parse(event.observedAt);
  });
  if (!eligible.length) return { count: 0, meanConfidence: null, successRate: null, gap: null, brier: null };
  const meanConfidence = eligible.reduce((sum, event) => sum + event.learning!.confidence!, 0) / eligible.length;
  const successRate = eligible.filter((event) => event.learning!.outcome === 'success').length / eligible.length * 100;
  const brier = eligible.reduce((sum, event) => sum + (event.learning!.confidence! / 100 - (event.learning!.outcome === 'success' ? 1 : 0)) ** 2, 0) / eligible.length;
  return { count: eligible.length, meanConfidence, successRate, gap: meanConfidence - successRate, brier };
}

/** Call with observations from a single concept and source revision. No fitted mastery score. */
export function summarizeLearning(events: Observation[]): LearningSummary {
  const scenarios = events.filter((event) => event.learning?.task === 'scenario');
  return {
    scenario: {
      total: scenarios.length,
      independentSuccess: scenarios.filter((event) => event.learning!.cue === 'independent'
        && event.learning!.outcome === 'success' && event.learning!.basis !== 'unknown'
        && event.exposure === 'unexposed' && !event.observedExposure).length,
      assisted: scenarios.filter((event) => ['hinted', 'lookup'].includes(event.learning!.cue)
        || event.exposure === 'exposed' || event.observedExposure).length,
      partial: scenarios.filter((event) => event.learning!.outcome === 'partial').length,
      failure: scenarios.filter((event) => event.learning!.outcome === 'failure').length,
      unverified: scenarios.filter((event) => event.learning!.outcome === 'unverified').length,
    },
    calibration: { concept: calibration(events, 'concept'), scenario: calibration(events, 'scenario') },
  };
}
