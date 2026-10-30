// Pure request validation for start-job (no network), so it can be unit tested.
export interface JobRequest {
  site_name: string;
  site_url?: string;
  sitemap_url?: string;
  input_path?: string;
  max_pages: number;
  estimate_only: boolean;
  recipient_email?: string;
}

const isHttpUrl = (s: string) => { try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; } };

export function validateRequest(body: any, userId: string): { ok: true; value: JobRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid request' };
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const site_name = str(body.site_name);
  if (!site_name || site_name.length > 100) return { ok: false, error: 'Site name is required (max 100 characters)' };

  const site_url = str(body.site_url);
  const sitemap_url = str(body.sitemap_url);
  if (site_url && !isHttpUrl(site_url)) return { ok: false, error: 'Homepage URL must start with http:// or https://' };
  if (sitemap_url && !isHttpUrl(sitemap_url)) return { ok: false, error: 'Sitemap URL must start with http:// or https://' };

  // Uploaded files must live in the caller's own folder (the UI uploads to <user id>/<name>).
  const input_path = str(body.input_path);
  if (input_path && (!input_path.startsWith(userId + '/') || input_path.includes('..'))) {
    return { ok: false, error: 'Uploaded file does not belong to you' };
  }
  if (!site_url && !sitemap_url && !input_path) {
    return { ok: false, error: 'Give a homepage URL, a sitemap URL, or upload a file' };
  }

  const mp = body.max_pages === undefined || body.max_pages === '' ? 200 : Number(body.max_pages);
  if (!Number.isInteger(mp) || mp < 1 || mp > 1000) return { ok: false, error: 'Max pages must be a whole number from 1 to 1000' };

  const recipient_email = str(body.recipient_email);
  if (recipient_email && !/^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(recipient_email)) return { ok: false, error: 'Recipient email is not valid' };

  return { ok: true, value: { site_name, site_url, sitemap_url, input_path, max_pages: mp, estimate_only: body.estimate_only === true, recipient_email } };
}
