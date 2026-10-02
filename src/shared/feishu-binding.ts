export type FeishuChannelState = 'disabled' | 'starting' | 'connected' | 'reconnecting' | 'error' | 'stopped';

export interface FeishuScope {
  appId: string;
  tenantKey: string;
}

export interface FeishuActor extends FeishuScope {
  openId: string;
}

export interface FeishuBindingView extends FeishuActor {
  id: string;
  boundAt: string;
}

export interface FeishuBindingRequestView {
  id: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'invalidated';
  expiresAt: string;
  confirmedAt: string | null;
}

export interface FeishuBindingStatus {
  scope: FeishuScope | null;
  channelState: FeishuChannelState;
  binding: FeishuBindingView | null;
  request: FeishuBindingRequestView | null;
}

/** Returned once to the initiating browser. Never persist the command in client storage. */
export interface FeishuBindingIssued {
  request: FeishuBindingRequestView;
  command: string;
}

/** Internal input from authenticated SDK events; never accept this object over HTTP. */
export interface FeishuBindingConfirmation extends FeishuActor {
  eventId: string;
  messageId: string;
  chatId: string;
  code: string;
}

export interface FeishuBindingConfirmationResult {
  status: 'confirmed' | 'duplicate' | 'rejected';
}
