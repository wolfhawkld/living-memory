/** Production capability declaration; not a signature or a full asset inventory. */
export const STATIC_BUILD_MANIFEST_FILE = 'living-memory-build.json';
export const STATIC_BUILD_MANIFEST_FORMAT = 'living-memory-static-build';
export const STATIC_BUILD_MANIFEST_VERSION = 1;
export const STATIC_BUILD_LEARNING_PROTOCOLS = [2, 3] as const;

export interface StaticBuildManifest {
  format: typeof STATIC_BUILD_MANIFEST_FORMAT;
  version: typeof STATIC_BUILD_MANIFEST_VERSION;
  supportedLearningProtocols: Array<2 | 3>;
  indexHtmlSha256: string;
}
