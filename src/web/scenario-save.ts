import type { ObservationRequest } from '../shared/types';

export interface ScenarioSaveHandlers {
  onSave: (request: ObservationRequest) => Promise<boolean>;
  onContinueApplication?: (request: ObservationRequest) => void | Promise<void>;
}

export interface ScenarioSaveOptions {
  /** True when the exact request was already retained by the parent. */
  observationSaved: boolean;
  /** Request the optional application / summary handoff after retention. */
  continueToApplication?: boolean;
}

export interface ScenarioSaveResult {
  /** The original object is returned unchanged so callers keep the frozen payload and event ID. */
  request: ObservationRequest;
  saved: boolean;
  continued: boolean;
  saveError: string | null;
  continuationError: string | null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Coordinate one immutable observation request with its optional follow-up.
 * This helper deliberately has no React or persistence state: the component
 * supplies whether this exact request was already retained.
 */
export async function saveScenarioRequest(
  request: ObservationRequest,
  handlers: ScenarioSaveHandlers,
  options: ScenarioSaveOptions,
): Promise<ScenarioSaveResult> {
  const continueToApplication = options.continueToApplication === true;
  if (!options.observationSaved) {
    let saved = false;
    try {
      saved = await handlers.onSave(request);
    } catch (error: unknown) {
      return {
        request,
        saved: false,
        continued: false,
        saveError: errorMessage(error, '记录没有确认写入，请检查连接后重试。'),
        continuationError: null,
      };
    }
    if (!saved) {
      return {
        request,
        saved: false,
        continued: false,
        saveError: '记录尚未确认写入，请检查连接后重试。',
        continuationError: null,
      };
    }
  }

  if (!continueToApplication) {
    return { request, saved: true, continued: false, saveError: null, continuationError: null };
  }
  if (!handlers.onContinueApplication) {
    return {
      request,
      saved: true,
      continued: false,
      saveError: null,
      continuationError: '应用 / 总结入口尚未就绪，请稍后重试。',
    };
  }
  try {
    await handlers.onContinueApplication(request);
    return { request, saved: true, continued: true, saveError: null, continuationError: null };
  } catch (error: unknown) {
    return {
      request,
      saved: true,
      continued: false,
      saveError: null,
      continuationError: errorMessage(error, '应用 / 总结入口尚未打开，请重试。'),
    };
  }
}
