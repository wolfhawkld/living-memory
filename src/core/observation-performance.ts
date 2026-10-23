import type { Observation } from '../shared/types.js';
import type { PrivacyObservation } from '../shared/answer-clearing.js';
import type { ObservationPrivacySummary } from '../shared/observation-privacy.js';
import { isAnswerCleared, isAnswerPrivacyEligible } from './answer-clearing.js';
import { projectObservationAssessments, type ObservationAssessmentProjection } from './observation-revisions.js';

export interface ObservationPerformanceProjection {
  /** Complete assessment adoption and diagnostics, including cleared parents. */
  assessments: ObservationAssessmentProjection<PrivacyObservation>;
  /** Privacy-eligible adopted observations; existing statistical conditions still apply. */
  observations: Observation[];
  privacy: ObservationPrivacySummary;
}

function privacyEligible(observation: PrivacyObservation): observation is Observation {
  return isAnswerPrivacyEligible(observation);
}

function performance(
  assessments: ObservationAssessmentProjection<PrivacyObservation>,
  rawObservations: readonly PrivacyObservation[],
): ObservationPerformanceProjection {
  const cutoff = Date.parse(assessments.asOf);
  let cleared = 0;
  for (const observation of rawObservations) {
    // Validate current privacy state even when a parent is withdrawn or its
    // revision chain is unresolved. A historical cutoff cannot undo clearing.
    if (isAnswerCleared(observation)
      && Date.parse(observation.observedAt) <= cutoff
      && Date.parse(observation.recordedAt) <= cutoff) cleared++;
  }
  const observations = assessments.effective.map(item => item.observation).filter(privacyEligible);
  return { assessments, observations, privacy: {
    cleared, excludedFromPerformance: assessments.effective.length - observations.length,
  } };
}

/** Project the complete authorized namespace before applying current answer privacy. */
export function projectObservationPerformance(
  rawObservations: readonly PrivacyObservation[], revisions: readonly unknown[], asOf: string,
): ObservationPerformanceProjection {
  return performance(projectObservationAssessments(rawObservations, revisions, asOf), rawObservations);
}

/**
 * Select a concept from an already complete projection by immutable parent
 * ownership. Never re-project a partial chain using a revision's claimed concept.
 */
export function selectObservationPerformanceForConcept(
  projection: ObservationPerformanceProjection,
  rawObservations: readonly PrivacyObservation[],
  conceptId: string,
): ObservationPerformanceProjection {
  const raw = rawObservations.filter(observation => observation.conceptId === conceptId);
  const parents = new Set(raw.map(observation => observation.eventId));
  const assessments = projection.assessments;
  return performance({
    asOf: assessments.asOf,
    effective: assessments.effective.filter(item => parents.has(item.observationEventId)),
    states: assessments.states.filter(item => parents.has(item.observationEventId)),
    issues: assessments.issues.filter(item => item.observationEventId !== null && parents.has(item.observationEventId)),
  }, raw);
}
