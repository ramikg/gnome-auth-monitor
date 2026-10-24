import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import type {
    LoginFailure,
    ProfileCredentialStatus,
    SessionStatus,
    SessionWithStatus,
    SsoSession,
} from '../types.js';
import {isFutureDate, loadTextFile, parseIsoDate, readJsonFile, sha1} from '../utils.js';

const AWS_CONFIG_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.aws', 'config']);
const CLI_CACHE_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.aws', 'cli', 'cache']);
const SSO_CACHE_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.aws', 'sso', 'cache']);

export const NO_SESSIONS_MESSAGE = 'No SSO sessions in ~/.aws/config';

interface SsoProfile {
    name: string;
    sessionName: string;
    accountId: string;
    roleName: string;
}

interface ConfigSection {
    kind: 'session' | 'profile';
    name: string;
    fields: Map<string, string>;
}

interface SsoCacheInfo {
    refreshDeadline: Date | null;
    accessTokenExpiresAt: Date | null;
}

const parseConfigFile = async (): Promise<ConfigSection[]> => {
    const contents = await loadTextFile(AWS_CONFIG_PATH);
    if (contents === null) return [];

    const sections: ConfigSection[] = [];
    let current: ConfigSection | null = null;

    for (const raw of contents.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;

        const sectionMatch = /^\[(.+)]$/.exec(line);
        if (sectionMatch) {
            if (current) sections.push(current);
            const header = sectionMatch[1].trim();
            const ssoMatch = /^sso-session\s+(.+)$/.exec(header);
            const profileMatch = /^profile\s+(.+)$/.exec(header);
            if (ssoMatch) {
                current = {
                    kind: 'session',
                    name: ssoMatch[1].trim(),
                    fields: new Map(),
                };
            } else if (profileMatch) {
                current = {
                    kind: 'profile',
                    name: profileMatch[1].trim(),
                    fields: new Map(),
                };
            } else if (header === 'default') {
                current = {kind: 'profile', name: 'default', fields: new Map()};
            } else {
                current = null;
            }
            continue;
        }

        if (!current) continue;
        const eqIndex = line.indexOf('=');
        if (eqIndex < 0) continue;
        const key = line.slice(0, eqIndex).trim();
        const value = line.slice(eqIndex + 1).trim();
        current.fields.set(key, value);
    }
    if (current) sections.push(current);

    return sections;
};

const sessionsFromSections = (sections: ConfigSection[]): SsoSession[] => {
    const sessions: SsoSession[] = [];
    for (const section of sections) {
        if (section.kind !== 'session') continue;
        const startUrl = section.fields.get('sso_start_url');
        if (!startUrl) continue;
        sessions.push({name: section.name, startUrl});
    }
    return sessions;
};

const profilesFromSections = (sections: ConfigSection[]): SsoProfile[] => {
    const profiles: SsoProfile[] = [];
    for (const section of sections) {
        if (section.kind !== 'profile') continue;
        const sessionName = section.fields.get('sso_session');
        const accountId = section.fields.get('sso_account_id');
        const roleName = section.fields.get('sso_role_name');
        if (!sessionName || !accountId || !roleName) continue;

        profiles.push({name: section.name, sessionName, accountId, roleName});
    }
    return profiles;
};

/**
 * Decode the refresh token's embedded expiry. AWS SSO refresh tokens have
 * the form `aor<base64url-payload>:<signature>`. The payload, once decoded,
 * begins with 4 zero bytes followed by a big-endian uint32 unix timestamp
 * (in seconds) – the moment AWS will stop accepting this refresh token.
 *
 * Returns null if the format doesn't match – AWS could change this any time.
 *
 * @param {string} token
 */
const decodeRefreshTokenExpiry = (token: string): Date | null => {
    if (!token.startsWith('aor')) return null;
    const body = token.slice(3).split(':', 1)[0];
    if (!body) return null;

    // base64url → standard base64 (GLib.base64_decode expects the standard alphabet)
    const standardBase64 = body.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (standardBase64.length % 4)) % 4;
    let bytes: Uint8Array;
    try {
        bytes = GLib.base64_decode(standardBase64 + '='.repeat(pad));
    } catch {
        return null;
    }
    if (bytes.length < 8) return null;

    const seconds =
        bytes[4] * 0x1000000 + bytes[5] * 0x10000 + bytes[6] * 0x100 + bytes[7];
    if (seconds <= 0) return null;
    return new Date(seconds * 1000);
};

const getSsoTokenCachePath = (session: SsoSession): string | null => {
    const hash = sha1(session.name);
    if (!hash) return null;
    return GLib.build_filenamev([SSO_CACHE_DIR, `${hash}.json`]);
};

/**
 * `~/.aws/cli/cache/<hash>.json` filename for an SSO profile.
 * The hash is sha1 of a JSON object whose keys are in alphabetical order – `{accountId, roleName, sessionName}`.
 *
 * @param {SsoProfile} profile
 */
const cliCacheHash = (profile: SsoProfile): string | null => {
    const args = {
        accountId: profile.accountId,
        roleName: profile.roleName,
        sessionName: profile.sessionName,
    };
    return sha1(JSON.stringify(args));
};

const readProfileCredentialExpiry = async (profile: SsoProfile): Promise<Date | null> => {
    const hash = cliCacheHash(profile);
    if (!hash) return null;
    const parsed = await readJsonFile(
        GLib.build_filenamev([CLI_CACHE_DIR, `${hash}.json`])
    );
    if (!parsed) return null;
    const credentials = parsed.Credentials as Record<string, unknown> | undefined;
    return parseIsoDate(credentials?.Expiration);
};

const readSsoCacheInfo = async (path: string): Promise<SsoCacheInfo> => {
    const parsed = await readJsonFile(path);
    if (!parsed) return {refreshDeadline: null, accessTokenExpiresAt: null};
    const refreshToken = parsed.refreshToken;
    const refreshDeadline =
        typeof refreshToken === 'string' ? decodeRefreshTokenExpiry(refreshToken) : null;
    const accessTokenExpiresAt = parseIsoDate(parsed.expiresAt);
    return {refreshDeadline, accessTokenExpiresAt};
};

const getSessionStatus = async (
    session: SsoSession,
    profiles: SsoProfile[]
): Promise<SessionStatus> => {
    const path = getSsoTokenCachePath(session);
    const {refreshDeadline, accessTokenExpiresAt} = path
        ? await readSsoCacheInfo(path)
        : {refreshDeadline: null, accessTokenExpiresAt: null};

    const credentials = await Promise.all(
        profiles
            .filter(profile => profile.sessionName === session.name)
            .map(async profile => ({
                profileName: profile.name,
                expiresAt: await readProfileCredentialExpiry(profile),
            }))
    );
    const profileCredentials: ProfileCredentialStatus[] = credentials.filter(
        (credential): credential is ProfileCredentialStatus =>
            credential.expiresAt !== null
    );

    return {
        active: isFutureDate(refreshDeadline),
        refreshDeadline,
        accessTokenExpiresAt,
        profileCredentials,
    };
};

export const readSessions = async (): Promise<SessionWithStatus[]> => {
    const sections = await parseConfigFile();
    const sessions = sessionsFromSections(sections);
    const profiles = profilesFromSections(sections);
    return Promise.all(
        sessions.map(async session => ({
            session,
            status: await getSessionStatus(session, profiles),
        }))
    );
};

export const spawnLoginProcess = (sessionName: string): LoginFailure | null => {
    const argv = ['aws', 'sso', 'login', '--sso-session', sessionName];
    try {
        Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        return null;
    } catch {
        return {
            title: 'AWS SSO login failed',
            body: `Could not run '${argv.join(' ')}'. Is the AWS CLI installed?`,
        };
    }
};
