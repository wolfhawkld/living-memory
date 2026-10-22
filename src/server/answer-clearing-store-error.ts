/** One error identity shared by the clearing kernel and its storage codecs. */
export class AnswerClearingStoreError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); this.name = 'AnswerClearingStoreError'; }
}
