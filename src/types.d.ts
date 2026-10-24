export interface SsoSession {
    name: string;
    startUrl: string;
}

export interface ProfileCredentialStatus {
    profileName: string;
    expiresAt: Date;
}

export interface SessionStatus {
    active: boolean;
    refreshDeadline: Date | null;
    accessTokenExpiresAt: Date | null;
    profileCredentials: ProfileCredentialStatus[];
}

export interface SessionWithStatus {
    session: SsoSession;
    status: SessionStatus;
}

export interface LoginFailure {
    title: string;
    body: string;
}
