export class LearningRuntimeVersionError extends Error {
  readonly code = 'RUNTIME_SCHEMA_VERSION_INVALID';
  constructor() { super('RUNTIME_SCHEMA_VERSION_INVALID'); this.name = 'LearningRuntimeVersionError'; }
}

/** An explicit launcher setting, never inferred from a database or build. */
export function parseLearningRuntimeVersion(value: unknown): 2 | 3 {
  if (value === undefined || value === '2') return 2;
  if (value === '3') return 3;
  throw new LearningRuntimeVersionError();
}
