export interface AccountUser {
  id: string;
  username: string;
  role: 'admin' | 'member';
  enabled: boolean;
  accessRevision: number;
}

export interface AccountStatus {
  enabled: boolean;
  needsSetup: boolean;
  user: AccountUser | null;
}

export interface AccountDirectory {
  users: AccountUser[];
}
