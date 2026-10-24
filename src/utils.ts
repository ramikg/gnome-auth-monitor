import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';

export const isFutureDate = (date: Date | null): boolean => {
    return date !== null && date.getTime() > Date.now();
};

export const getTimeRemainingString = (expiresAt: Date): string => {
    const diffMs = expiresAt.getTime() - Date.now();
    if (diffMs <= 0) return 'expired';
    const days = Math.floor(diffMs / 86_400_000);
    const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
    const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
    if (days > 0) return `${days}d ${hours}h left`;
    if (hours > 0) return `${hours}h ${minutes}m left`;
    if (minutes > 0) return `${minutes}m left`;
    return '<1m left';
};

export const openUrl = (url: string): boolean => {
    try {
        return Gio.AppInfo.launch_default_for_uri(url, null);
    } catch {
        Main.notifyError(
            'Could not open SSO start URL',
            `No application is registered to open ${url}.`
        );
        return false;
    }
};

export const loadTextFile = (path: string): Promise<string | null> => {
    const file = Gio.File.new_for_path(path);
    // Async IO so the shell's main loop never blocks on disk (EGO-X-004).
    return new Promise(resolve => {
        file.load_contents_async(null, (_file, result) => {
            try {
                const [ok, data] = file.load_contents_finish(result);
                resolve(ok ? new TextDecoder().decode(data) : null);
            } catch {
                resolve(null);
            }
        });
    });
};

export const sha1 = (input: string): string | null => {
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, input, -1);
};

export const parseIsoDate = (value: unknown): Date | null => {
    if (typeof value !== 'string') return null;
    const d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return d;
};

export const readJsonFile = async (
    path: string
): Promise<Record<string, unknown> | null> => {
    const text = await loadTextFile(path);
    if (text === null) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};
