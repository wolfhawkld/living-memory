/** Privacy exclusions are separate from assessment adoption and statistical eligibility. */
export interface ObservationPrivacySummary {
  /** Currently cleared raw observations that had occurred and been recorded by asOf. */
  cleared: number;
  /** Assessment-active observations excluded by the current answer privacy state. */
  excludedFromPerformance: number;
}
